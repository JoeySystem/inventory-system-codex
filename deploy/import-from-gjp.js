#!/usr/bin/env node
/**
 * 管家婆数据迁移工具
 *
 * 将管家婆导出的 Excel 数据导入到 OvO System
 *
 * 用法:
 *   node deploy/import-from-gjp.js --inventory <库存表.xlsx> [--bom <生产模板.xlsx>] [--dry-run]
 *
 * 参数:
 *   --inventory   库存状况表（商品库存）Excel 文件路径（必须）
 *   --bom         生产模板明细 Excel 文件路径（可选）
 *   --dry-run     仅分析不写入数据库（可选）
 *   --warehouse   指定入库仓库名称（默认: 主仓库）
 */

const path = require('path');
const fs = require('fs');

// 加载环境
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const ExcelJS = require('exceljs');
const { getDB, closeDB } = require('../server/db/database');
const { generatePinyinFields } = require('../server/utils/pinyin');

// ============================================
// 参数解析
// ============================================
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf('--' + name);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
const dryRun = args.includes('--dry-run');
const inventoryFile = getArg('inventory');
const bomFile = getArg('bom');
const warehouseName = getArg('warehouse') || '主仓库';

if (!inventoryFile) {
    console.log(`
╔══════════════════════════════════════════════════════╗
║        管家婆 → OvO System 数据迁移工具             ║
╚══════════════════════════════════════════════════════╝

用法:
  node deploy/import-from-gjp.js --inventory <库存表.xlsx> [--bom <生产模板.xlsx>] [--dry-run]

参数:
  --inventory   库存状况表（商品库存）Excel 文件（必须）
  --bom         生产模板明细 Excel 文件（可选）
  --dry-run     仅分析预览，不写入数据库
  --warehouse   入库仓库名称（默认: 主仓库）

示例:
  node deploy/import-from-gjp.js --inventory 库存表.xlsx --bom 生产模板.xlsx
  node deploy/import-from-gjp.js --inventory 库存表.xlsx --dry-run
`);
    process.exit(0);
}

// ============================================
// 主流程
// ============================================
async function main() {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║     管家婆 → OvO System 数据迁移' + (dryRun ? '（预览模式）' : '              ') + '║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    if (!fs.existsSync(inventoryFile)) {
        console.error('[X] 库存表文件不存在:', inventoryFile);
        process.exit(1);
    }

    const db = getDB();
    const stats = {
        categories: { created: 0, existed: 0 },
        materials: { created: 0, skipped: 0, errors: [] },
        inventory: { entries: 0, totalQty: 0 },
        boms: { created: 0, items: 0, errors: [] }
    };

    try {
        // ========================================
        // 第 1 步：读取库存表
        // ========================================
        console.log('[1/4] 读取库存状况表...');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(inventoryFile);
        const ws = wb.worksheets[0];

        // 解析表头（第5-6行是表头）
        // 数据从第7行开始
        const materials = [];
        for (let r = 7; r <= ws.rowCount; r++) {
            const row = ws.getRow(r);
            const cat1 = String(row.getCell(1).value || '').trim();
            const cat2 = String(row.getCell(2).value || '').trim();
            const cat3 = String(row.getCell(3).value || '').trim();
            const name = String(row.getCell(5).value || '').trim();
            const gjpCode = String(row.getCell(6).value || '').trim();
            const spec = String(row.getCell(7).value || '').trim();
            const model = String(row.getCell(8).value || '').trim();
            const brand = String(row.getCell(9).value || '').trim();
            const salePrice = parseFloat(row.getCell(10).value) || 0;
            const costPrice = parseFloat(row.getCell(11).value) || 0;
            const stock = parseFloat(row.getCell(14).value) || 0;
            const unit = String(row.getCell(15).value || '').trim();
            const avgCost = parseFloat(row.getCell(17).value) || 0;
            const createdAt = String(row.getCell(23).value || '').trim();

            // 跳过空行和合计行
            if (!name || cat1 === '合计' || name === '合计') continue;

            // 组合分类名（去掉空级别）
            const categoryParts = [cat1, cat2, cat3].filter(c => c && c !== cat1);
            let categoryName = cat1;
            if (cat2 && cat2 !== cat1) {
                categoryName = cat1 + '-' + cat2;
            }

            // 合并规格和型号
            let fullSpec = [spec, model].filter(s => s).join(' / ');

            materials.push({
                name,
                gjpCode,
                category: categoryName || '未分类',
                spec: fullSpec,
                brand,
                salePrice,
                costPrice: avgCost > 0 ? avgCost : costPrice,
                stock: Math.max(0, stock),  // 负库存归零
                unit: unit || '件',
                createdAt
            });
        }

        console.log(`  找到 ${materials.length} 条物料记录`);
        console.log(`  其中 ${materials.filter(m => m.stock > 0).length} 条有库存`);
        console.log('');

        // ========================================
        // 第 2 步：创建分类 + 导入物料
        // ========================================
        console.log('[2/4] 导入物料...');

        // 收集所有分类
        const categoryNames = [...new Set(materials.map(m => m.category))];
        console.log(`  发现 ${categoryNames.length} 个分类: ${categoryNames.slice(0, 10).join(', ')}${categoryNames.length > 10 ? '...' : ''}`);

        if (!dryRun) {
            // 创建分类
            const insertCat = db.prepare(`
                INSERT OR IGNORE INTO categories (name, name_pinyin, name_pinyin_abbr)
                VALUES (?, ?, ?)
            `);

            for (const catName of categoryNames) {
                const { fullPinyin, abbr } = generatePinyinFields(catName);
                const existing = db.prepare('SELECT id FROM categories WHERE name = ?').get(catName);
                if (existing) {
                    stats.categories.existed++;
                } else {
                    insertCat.run(catName, fullPinyin, abbr);
                    stats.categories.created++;
                }
            }

            // 构建分类 name → id 映射
            const catMap = {};
            db.prepare('SELECT id, name FROM categories').all().forEach(c => {
                catMap[c.name] = c.id;
            });

            // 生成物料编码
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            let seqNum = 1;
            const lastCode = db.prepare(
                "SELECT code FROM materials WHERE code LIKE ? ORDER BY code DESC LIMIT 1"
            ).get(`MAT-${today}-%`);
            if (lastCode) {
                seqNum = parseInt(lastCode.code.split('-')[2]) + 1;
            }

            // 插入物料（事务）
            const insertMaterial = db.prepare(`
                INSERT INTO materials (code, name, name_pinyin, name_pinyin_abbr, category_id, unit, spec, brand, cost_price, sale_price, notes, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            `);

            const importMaterials = db.transaction(() => {
                for (const m of materials) {
                    // 检查重复（名称 + 规格）
                    let existing;
                    if (m.spec) {
                        existing = db.prepare('SELECT id FROM materials WHERE name = ? AND spec = ?').get(m.name, m.spec);
                    } else {
                        existing = db.prepare('SELECT id FROM materials WHERE name = ? AND (spec IS NULL OR spec = ?)').get(m.name, '');
                    }

                    if (existing) {
                        stats.materials.skipped++;
                        continue;
                    }

                    try {
                        const code = `MAT-${today}-${String(seqNum++).padStart(3, '0')}`;
                        const { fullPinyin, abbr } = generatePinyinFields(m.name);
                        const catId = catMap[m.category] || null;
                        const ts = m.createdAt || new Date().toISOString().replace('T', ' ').slice(0, 19);

                        insertMaterial.run(
                            code, m.name, fullPinyin, abbr,
                            catId, m.unit, m.spec || null, m.brand || null,
                            m.costPrice, m.salePrice,
                            m.gjpCode ? `管家婆编号: ${m.gjpCode}` : null,
                            ts, ts
                        );
                        stats.materials.created++;
                    } catch (err) {
                        stats.materials.errors.push(`${m.name}: ${err.message}`);
                    }
                }
            });

            importMaterials();
        } else {
            stats.materials.created = materials.length;
            console.log('  [预览] 将导入 ' + materials.length + ' 条物料');
        }

        console.log(`  ✅ 分类: 新建 ${stats.categories.created}, 已存在 ${stats.categories.existed}`);
        console.log(`  ✅ 物料: 导入 ${stats.materials.created}, 跳过 ${stats.materials.skipped}, 失败 ${stats.materials.errors.length}`);
        if (stats.materials.errors.length > 0) {
            console.log('  ⚠️ 失败详情:');
            stats.materials.errors.slice(0, 5).forEach(e => console.log('    - ' + e));
            if (stats.materials.errors.length > 5) console.log(`    ... 还有 ${stats.materials.errors.length - 5} 条`);
        }
        console.log('');

        // ========================================
        // 第 3 步：导入库存
        // ========================================
        console.log('[3/4] 导入库存数据...');

        if (!dryRun) {
            // 获取仓库
            let warehouse = db.prepare('SELECT id FROM warehouses WHERE name = ?').get(warehouseName);
            if (!warehouse) {
                const { fullPinyin, abbr } = generatePinyinFields(warehouseName);
                db.prepare('INSERT INTO warehouses (name, name_pinyin, name_pinyin_abbr, notes) VALUES (?, ?, ?, ?)')
                    .run(warehouseName, fullPinyin, abbr, '管家婆数据迁移自动创建');
                warehouse = db.prepare('SELECT id FROM warehouses WHERE name = ?').get(warehouseName);
            }

            // 构建 name+spec → material_id 映射
            const matMap = {};
            db.prepare('SELECT id, name, spec FROM materials WHERE is_active = 1').all().forEach(m => {
                const key = m.name + '|' + (m.spec || '');
                matMap[key] = m.id;
            });

            const importStock = db.transaction(() => {
                for (const m of materials) {
                    if (m.stock <= 0) continue;

                    const key = m.name + '|' + (m.spec || '');
                    const materialId = matMap[key];
                    if (!materialId) continue;

                    // 插入/更新库存
                    db.prepare(`
                        INSERT INTO inventory (material_id, warehouse_id, quantity)
                        VALUES (?, ?, ?)
                        ON CONFLICT(material_id, warehouse_id)
                        DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = datetime('now', 'localtime')
                    `).run(materialId, warehouse.id, Math.round(m.stock));

                    // 记录入库流水
                    db.prepare(`
                        INSERT INTO stock_movements (type, material_id, warehouse_id, quantity, unit_price, total_price, reference_no, notes, created_by)
                        VALUES ('in', ?, ?, ?, ?, ?, ?, ?, 1)
                    `).run(
                        materialId, warehouse.id, Math.round(m.stock),
                        m.costPrice, Math.round(m.stock) * m.costPrice,
                        'GJP-MIGRATE', '管家婆数据迁移-期初库存'
                    );

                    stats.inventory.entries++;
                    stats.inventory.totalQty += Math.round(m.stock);
                }
            });

            importStock();
        } else {
            const withStock = materials.filter(m => m.stock > 0);
            stats.inventory.entries = withStock.length;
            stats.inventory.totalQty = withStock.reduce((s, m) => s + Math.round(m.stock), 0);
            console.log(`  [预览] 将导入 ${withStock.length} 条库存记录`);
        }

        console.log(`  ✅ 库存: ${stats.inventory.entries} 种物料入库, 总数量 ${stats.inventory.totalQty}`);
        console.log('');

        // ========================================
        // 第 4 步：导入 BOM（生产模板）
        // ========================================
        if (bomFile) {
            console.log('[4/4] 导入生产模板 (BOM)...');

            if (!fs.existsSync(bomFile)) {
                console.error('  [X] 生产模板文件不存在:', bomFile);
            } else {
                const wb2 = new ExcelJS.Workbook();
                await wb2.xlsx.readFile(bomFile);
                const ws2 = wb2.worksheets[0];

                // 解析模板：按模板名称分组
                // 表头在第3行，数据从第4行开始
                const templates = new Map();
                for (let r = 4; r <= ws2.rowCount; r++) {
                    const row = ws2.getRow(r);
                    const cat1 = String(row.getCell(2).value || '').trim();
                    const cat2 = String(row.getCell(3).value || '').trim();
                    const tplCode = String(row.getCell(6).value || '').trim();
                    const tplName = String(row.getCell(7).value || '').trim();
                    const productCode = String(row.getCell(8).value || '').trim();
                    const productName = String(row.getCell(9).value || '').trim();
                    const status = String(row.getCell(14).value || '').trim();
                    const matName = String(row.getCell(15).value || '').trim();
                    const matCode = String(row.getCell(16).value || '').trim();
                    const qty = parseFloat(row.getCell(22).value) || 0;
                    const matUnit = String(row.getCell(23).value || '').trim();

                    if (!tplName || !matName) continue;

                    if (!templates.has(tplName)) {
                        templates.set(tplName, {
                            name: tplName,
                            code: tplCode,
                            category: [cat1, cat2].filter(c => c).join('-') || '生产',
                            productName,
                            productCode,
                            status,
                            items: []
                        });
                    }
                    templates.get(tplName).items.push({ matName, matCode, qty, unit: matUnit });
                }

                console.log(`  发现 ${templates.size} 个生产模板`);

                if (!dryRun) {
                    // 构建物料名称 → id 映射
                    const allMats = db.prepare('SELECT id, name FROM materials WHERE is_active = 1').all();
                    const matNameMap = {};
                    allMats.forEach(m => { matNameMap[m.name] = m.id; });

                    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                    let bomSeq = 1;
                    const lastBom = db.prepare("SELECT code FROM boms WHERE code LIKE ? ORDER BY code DESC LIMIT 1").get(`BOM-${today}-%`);
                    if (lastBom) {
                        bomSeq = parseInt(lastBom.code.split('-')[2]) + 1;
                    }

                    const importBOMs = db.transaction(() => {
                        for (const [tplName, tpl] of templates) {
                            try {
                                const bomCode = `BOM-${today}-${String(bomSeq++).padStart(3, '0')}`;
                                const { fullPinyin, abbr } = generatePinyinFields(tplName);

                                // 查找产出物料
                                let outputMaterialId = null;
                                if (tpl.productName) {
                                    const outMat = db.prepare('SELECT id FROM materials WHERE name = ?').get(tpl.productName);
                                    if (outMat) outputMaterialId = outMat.id;
                                }

                                // 创建 BOM
                                const result = db.prepare(`
                                    INSERT INTO boms (name, code, version, output_material_id, output_quantity, category, description, status, name_pinyin, name_pinyin_abbr, created_by)
                                    VALUES (?, ?, '1.0', ?, 1, ?, ?, 'active', ?, ?, 1)
                                `).run(
                                    tplName, bomCode,
                                    outputMaterialId,
                                    tpl.category,
                                    `从管家婆生产模板迁移 (原编号: ${tpl.code || 'N/A'})`,
                                    fullPinyin, abbr
                                );

                                const bomId = result.lastInsertRowid;
                                let itemOrder = 0;
                                let matchedItems = 0;

                                for (const item of tpl.items) {
                                    const materialId = matNameMap[item.matName];
                                    if (!materialId) {
                                        // 物料未找到，记录在备注中
                                        continue;
                                    }

                                    db.prepare(`
                                        INSERT INTO bom_items (bom_id, material_id, quantity, notes, sort_order)
                                        VALUES (?, ?, ?, ?, ?)
                                    `).run(bomId, materialId, item.qty, null, itemOrder++);
                                    matchedItems++;
                                    stats.boms.items++;
                                }

                                stats.boms.created++;

                                if (matchedItems < tpl.items.length) {
                                    const missing = tpl.items.length - matchedItems;
                                    // 更新描述记录未匹配的物料
                                    db.prepare("UPDATE boms SET description = description || ? WHERE id = ?")
                                        .run(`\n⚠️ ${missing}/${tpl.items.length} 种物料未匹配到库存表中的物料`, bomId);
                                }

                            } catch (err) {
                                stats.boms.errors.push(`${tplName}: ${err.message}`);
                            }
                        }
                    });

                    importBOMs();
                } else {
                    stats.boms.created = templates.size;
                    let totalItems = 0;
                    for (const [, tpl] of templates) totalItems += tpl.items.length;
                    stats.boms.items = totalItems;
                    console.log(`  [预览] 将导入 ${templates.size} 个BOM, 共 ${totalItems} 条明细`);
                }

                console.log(`  ✅ BOM: 导入 ${stats.boms.created} 个, 共 ${stats.boms.items} 条物料明细`);
                if (stats.boms.errors.length > 0) {
                    console.log('  ⚠️ 失败:');
                    stats.boms.errors.forEach(e => console.log('    - ' + e));
                }
            }
        } else {
            console.log('[4/4] 未指定生产模板文件，跳过 BOM 导入');
        }

        // ========================================
        // 汇总报告
        // ========================================
        console.log('');
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log(dryRun
            ? '║              迁移预览完成（未写入数据）               ║'
            : '║              数据迁移完成！                           ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  分类:  新建 ${String(stats.categories.created).padStart(4)}, 已有 ${String(stats.categories.existed).padStart(4)}                    ║`);
        console.log(`║  物料:  导入 ${String(stats.materials.created).padStart(4)}, 跳过 ${String(stats.materials.skipped).padStart(4)}, 失败 ${String(stats.materials.errors.length).padStart(3)}            ║`);
        console.log(`║  库存:  ${String(stats.inventory.entries).padStart(4)} 种物料, 总数量 ${String(stats.inventory.totalQty).padStart(8)}            ║`);
        console.log(`║  BOM:   导入 ${String(stats.boms.created).padStart(4)}, 共 ${String(stats.boms.items).padStart(5)} 条明细               ║`);
        console.log('╠══════════════════════════════════════════════════════╣');
        if (dryRun) {
            console.log('║  确认无误后去掉 --dry-run 参数执行正式导入           ║');
        } else {
            console.log('║  管家婆编号已保存在物料备注中供参考                  ║');
            console.log('║  库存流水标记为 GJP-MIGRATE 便于追溯                ║');
        }
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');

    } finally {
        closeDB();
    }
}

main().catch(err => {
    console.error('[X] 迁移出错:', err.message);
    closeDB();
    process.exit(1);
});
