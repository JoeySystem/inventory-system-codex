/**
 * BOM 物料清单路由
 * GET    /api/boms                    - BOM 列表
 * GET    /api/boms/:id                - BOM 详情（含多级展开 + 成本卷算）
 * POST   /api/boms                    - 创建 BOM
 * PUT    /api/boms/:id                - 更新 BOM（自动保存版本快照）
 * DELETE /api/boms/:id                - 删除 BOM
 * POST   /api/boms/:id/duplicate      - 复制 BOM
 * GET    /api/boms/where-used/:materialId - 物料反查（在哪些 BOM 中使用）
 * GET    /api/boms/:id/versions       - 版本历史
 * POST   /api/boms/:id/restore/:versionId - 恢复历史版本
 * GET    /api/boms/:id/cost           - 成本分析
 */

const express = require('express');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { logOperation } = require('../utils/logger');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { generatePinyinFields } = require('../utils/pinyin');

const router = express.Router();
router.use(requireAuth);

function getSupplyModeMeta(mode) {
    const map = {
        purchase_only: { label: '采购入库后领用', hint: '先采购收货入库，再按单据领用。' },
        direct_issue: { label: '库存现成件直接领用', hint: '库内现成件可直接发料，不需要前置工单。' },
        prebuild_wip: { label: '先做半成品再领用', hint: '应先由前置工单做成半成品，再在当前装配或生产中领用。' },
        on_site_fabrication: { label: '当前工单现场加工', hint: '仓库发出原材，车间在当前工单现场裁剪、焊接或装配。' }
    };
    return map[mode] || map.direct_issue;
}

function getSupplyRiskLevel(score) {
    if (score >= 90) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    return 'normal';
}

function getMaterialSupplyRiskContext(db, materialId, warehouseId) {
    if (!materialId) return null;
    const material = db.prepare(`
        SELECT id, name, code, is_single_source, lead_time_days, is_key_part,
               safety_stock, min_stock, reorder_point, coverage_days_target, supply_risk_notes
        FROM materials
        WHERE id = ?
    `).get(materialId);
    if (!material) return null;

    let stockQuery = 'SELECT COALESCE(SUM(quantity), 0) as total FROM inventory WHERE material_id = ?';
    const stockParams = [materialId];
    if (warehouseId) {
        stockQuery += ' AND warehouse_id = ?';
        stockParams.push(warehouseId);
    }
    const currentStock = Number(db.prepare(stockQuery).get(...stockParams)?.total || 0);

    const supplierRow = db.prepare(`
        SELECT COUNT(*) as supplier_count,
               MAX(CASE WHEN is_default = 1 THEN lead_time_days END) as default_lead_time_days,
               MAX(CASE WHEN is_default = 1 THEN source_platform END) as default_source_platform
        FROM material_suppliers
        WHERE material_id = ?
    `).get(materialId);
    const substitutionCount = Number(db.prepare(`
        SELECT COUNT(*) as cnt
        FROM material_substitutions
        WHERE material_id = ? AND COALESCE(is_active, 1) = 1
    `).get(materialId)?.cnt || 0);
    const avgDailyConsumption = Number(db.prepare(`
        SELECT COALESCE(SUM(ABS(quantity)), 0) / 30.0 as avg_qty
        FROM stock_movements
        WHERE material_id = ?
          AND type = 'out'
          AND datetime(created_at) >= datetime('now', 'localtime', '-30 days')
    `).get(materialId)?.avg_qty || 0);

    const supplierCount = Number(supplierRow?.supplier_count || 0);
    const singleSource = Number(material.is_single_source || 0) === 1 || supplierCount === 1;
    const effectiveLeadTimeDays = Number(supplierRow?.default_lead_time_days || material.lead_time_days || 0);
    const hasSubstitution = substitutionCount > 0;
    const warningThreshold = Number(material.safety_stock || material.min_stock || 0);
    const reorderPoint = Number(material.reorder_point || 0);
    const coverageDaysTarget = Number(material.coverage_days_target || 0);
    const safetyBufferDays = 3;
    const coverageDays = avgDailyConsumption > 0 ? currentStock / avgDailyConsumption : null;
    const reasons = [];
    const recommendedActions = [];
    let score = 0;

    if (singleSource) {
        score += 40;
        reasons.push('唯一供应商');
        recommendedActions.push('优先核对唯一供应商交期与备货计划');
    }
    if (effectiveLeadTimeDays >= 30) {
        score += 40;
        reasons.push(`交期 ${effectiveLeadTimeDays} 天`);
    } else if (effectiveLeadTimeDays >= 14) {
        score += 30;
        reasons.push(`交期 ${effectiveLeadTimeDays} 天`);
    } else if (effectiveLeadTimeDays >= 7) {
        score += 20;
        reasons.push(`交期 ${effectiveLeadTimeDays} 天`);
    }
    if (effectiveLeadTimeDays >= 7) {
        recommendedActions.push('提前锁定采购交期并预留缓冲');
    }
    if (!hasSubstitution) {
        score += 25;
        reasons.push('无替代料');
        recommendedActions.push('评估并维护可替代料');
    }
    if (Number(material.is_key_part || 0) === 1) {
        score += 25;
        reasons.push('关键件');
    }
    if (warningThreshold > 0 && currentStock <= warningThreshold) {
        score += 20;
        reasons.push('低于安全阈值');
        recommendedActions.push('补安全库存或上调预警阈值');
    }
    if (reorderPoint > 0 && currentStock <= reorderPoint) {
        score += 15;
        reasons.push('低于补货点');
    }
    if (coverageDays !== null && effectiveLeadTimeDays > 0 && coverageDays < (effectiveLeadTimeDays + safetyBufferDays)) {
        score += 25;
        reasons.push(`库存仅够 ${coverageDays.toFixed(1)} 天，低于交期+缓冲 ${effectiveLeadTimeDays + safetyBufferDays} 天`);
        recommendedActions.push('优先安排补货或调整生产排程');
    }
    if (coverageDays !== null && coverageDaysTarget > 0 && coverageDays < coverageDaysTarget) {
        score += 15;
        reasons.push(`库存仅够 ${coverageDays.toFixed(1)} 天，低于目标保供天数 ${coverageDaysTarget} 天`);
    }

    const procurementAdvice = {
        urgency: 'normal',
        actionLabel: '持续观察',
        primaryAction: '持续观察供应风险变化',
        buyerHint: '保持例行跟踪'
    };
    if (getSupplyRiskLevel(score) === 'critical' || (coverageDays !== null && effectiveLeadTimeDays > 0 && coverageDays < (effectiveLeadTimeDays + safetyBufferDays))) {
        procurementAdvice.urgency = 'urgent';
        procurementAdvice.actionLabel = '采购任务';
        procurementAdvice.primaryAction = '建议立即生成采购任务并锁定交期';
        procurementAdvice.buyerHint = '优先联系供应商确认可交期、可供数量和替代渠道';
    } else if (getSupplyRiskLevel(score) === 'high' || singleSource || effectiveLeadTimeDays >= 7) {
        procurementAdvice.urgency = 'high';
        procurementAdvice.actionLabel = '采购跟进';
        procurementAdvice.primaryAction = '建议生成采购跟进任务';
        procurementAdvice.buyerHint = '尽快核对库存覆盖、交期缓冲和备料计划';
    } else if (!hasSubstitution) {
        procurementAdvice.urgency = 'medium';
        procurementAdvice.actionLabel = '备料任务';
        procurementAdvice.primaryAction = '建议生成备料/替代料治理任务';
        procurementAdvice.buyerHint = '补第二来源或替代工艺路线';
    }

    return {
        materialId: Number(material.id),
        materialName: material.name,
        materialCode: material.code,
        riskScore: score,
        riskLevel: getSupplyRiskLevel(score),
        reasons,
        recommendedActions: Array.from(new Set(recommendedActions)),
        singleSource,
        effectiveLeadTimeDays,
        hasSubstitution,
        isKeyPart: Number(material.is_key_part || 0) === 1,
        currentStock,
        warningThreshold,
        coverageDays,
        coverageDaysTarget,
        safetyBufferDays,
        sourcePlatform: supplierRow?.default_source_platform || null,
        riskNotes: material.supply_risk_notes || null,
        procurementAdvice
    };
}

function findBomSnapshotReferences(db, bomId) {
    const sql = `
        SELECT id, order_no, status
        FROM production_orders
        WHERE bom_snapshot_json IS NOT NULL
          AND json_valid(bom_snapshot_json)
          AND CAST(json_extract(bom_snapshot_json, '$.sourceBomId') AS INTEGER) = ?
        ORDER BY id DESC
    `;

    try {
        return db.prepare(sql).all(Number(bomId));
    } catch (error) {
        const message = String(error?.message || '');
        if (!/json_extract|json_valid|malformed JSON|no such function/i.test(message)) {
            throw error;
        }

        const rows = db.prepare(`
            SELECT id, order_no, status, bom_snapshot_json
            FROM production_orders
            WHERE bom_snapshot_json IS NOT NULL
        `).all();

        return rows
            .filter(row => {
                try {
                    const snapshot = JSON.parse(row.bom_snapshot_json);
                    return Number(snapshot?.sourceBomId) === Number(bomId);
                } catch {
                    return false;
                }
            })
            .map(({ id, order_no, status }) => ({ id, order_no, status }));
    }
}

/**
 * 生成 BOM 编码 BOM-YYYYMMDD-NNN
 */
function generateBomCode(db) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const last = db.prepare(
        "SELECT code FROM boms WHERE code LIKE ? ORDER BY code DESC LIMIT 1"
    ).get(`BOM-${today}-%`);
    let seq = 1;
    if (last) {
        const parts = last.code.split('-');
        seq = parseInt(parts[2]) + 1;
    }
    return `BOM-${today}-${String(seq).padStart(3, '0')}`;
}

/**
 * 递归展开 BOM（多级），带循环检测
 */
function expandBom(db, bomId, quantity = 1, level = 0, visited = new Set()) {
    if (visited.has(bomId)) {
        throw new ValidationError(`检测到循环引用: BOM ID ${bomId}`);
    }
    if (level > 10) {
        throw new ValidationError('BOM 层级超过10层限制');
    }
    visited.add(bomId);

    const items = db.prepare(`
        SELECT bi.*,
               m.name as material_name, m.code as material_code, m.unit, m.spec, m.cost_price, m.sale_price, m.material_type, m.supply_mode,
               sb.name as sub_bom_name, sb.code as sub_bom_code, sb.version as sub_bom_version
        FROM bom_items bi
        LEFT JOIN materials m ON bi.material_id = m.id
        LEFT JOIN boms sb ON bi.sub_bom_id = sb.id
        ORDER BY bi.sort_order, bi.id
    `).all().filter(i => i.bom_id === bomId);

    const result = [];

    for (const item of items) {
        const effectiveQty = item.quantity * quantity;
        const lossMultiplier = 1 + (item.loss_rate || 0) / 100;
        const actualQty = effectiveQty * lossMultiplier;

        if (item.sub_bom_id) {
            // 子 BOM：递归展开
            const subResult = {
                ...item,
                level,
                is_sub_bom: true,
                effective_quantity: effectiveQty,
                actual_quantity: actualQty,
                children: expandBom(db, item.sub_bom_id, actualQty, level + 1, new Set(visited))
            };
            // 计算子 BOM 成本
            subResult.sub_cost = subResult.children.reduce((sum, c) => sum + (c.line_cost || 0), 0);
            subResult.line_cost = subResult.sub_cost;
            result.push(subResult);
        } else {
            // 叶子物料
            const unitCost = item.cost_price || 0;
            result.push({
                ...item,
                level,
                is_sub_bom: false,
                effective_quantity: effectiveQty,
                actual_quantity: actualQty,
                line_cost: actualQty * unitCost,
                allow_substitution: Boolean(item.allow_substitution),
                substitution_priority: Number(item.substitution_priority || 1),
                supply_mode_label: getSupplyModeMeta(item.supply_mode).label,
                supply_mode_hint: getSupplyModeMeta(item.supply_mode).hint
            });
        }
    }

    visited.delete(bomId);
    return result;
}

/**
 * 将展开的树形结构扁平化（用于成本汇总和物料需求）
 */
function flattenBom(items) {
    const flat = [];
    for (const item of items) {
        flat.push(item);
        if (item.children) {
            flat.push(...flattenBom(item.children));
        }
    }
    return flat;
}

/**
 * GET /api/boms
 */
router.get('/', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const { q, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClauses = ['b.is_active = 1'];
    let params = [];

    if (status) { whereClauses.push('b.status = ?'); params.push(status); }
    if (q) {
        const term = `%${q.toLowerCase()}%`;
        whereClauses.push('(LOWER(b.name) LIKE ? OR b.name_pinyin LIKE ? OR b.name_pinyin_abbr LIKE ? OR LOWER(b.code) LIKE ?)');
        params.push(term, term, term, term);
    }

    const whereSQL = whereClauses.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM boms b WHERE ${whereSQL}`).get(...params).cnt;

    const boms = db.prepare(`
        SELECT b.*,
               om.name as output_material_name, om.code as output_material_code, om.unit as output_unit,
               u.display_name as creator_name,
               (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id) as item_count,
               (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id AND bi.sub_bom_id IS NOT NULL) as sub_bom_count
        FROM boms b
        LEFT JOIN materials om ON b.output_material_id = om.id
        LEFT JOIN users u ON b.created_by = u.id
        WHERE ${whereSQL}
        ORDER BY b.updated_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({
        success: true,
        data: {
            boms,
            pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
        }
    });
});

/**
 * GET /api/boms/:id
 */
router.get('/:id', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const bom = db.prepare(`
        SELECT b.*,
               om.name as output_material_name, om.code as output_material_code, om.unit as output_unit,
               u.display_name as creator_name
        FROM boms b
        LEFT JOIN materials om ON b.output_material_id = om.id
        LEFT JOIN users u ON b.created_by = u.id
        WHERE b.id = ? AND b.is_active = 1
    `).get(req.params.id);

    if (!bom) throw new NotFoundError('BOM');

    // 多级展开
    const tree = expandBom(db, bom.id);
    const flatItems = flattenBom(tree);

    // 成本汇总
    const totalCost = tree.reduce((sum, item) => sum + (item.line_cost || 0), 0);

    // 叶子物料汇总（合并相同物料）
    const leafMaterials = {};
    for (const item of flatItems) {
        if (!item.is_sub_bom && item.material_id) {
            if (!leafMaterials[item.material_id]) {
                leafMaterials[item.material_id] = {
                    material_id: item.material_id,
                    name: item.material_name,
                    code: item.material_code,
                    unit: item.unit,
                    spec: item.spec,
                    cost_price: item.cost_price,
                    supply_mode: item.supply_mode || 'direct_issue',
                    supply_mode_label: getSupplyModeMeta(item.supply_mode).label,
                    total_quantity: 0,
                    total_cost: 0
                };
            }
            leafMaterials[item.material_id].total_quantity += item.actual_quantity;
            leafMaterials[item.material_id].total_cost += item.line_cost || 0;
        }
    }

    // 版本数
    const versionCount = db.prepare('SELECT COUNT(*) as cnt FROM bom_versions WHERE bom_id = ?').get(bom.id).cnt;

    res.json({
        success: true,
        data: {
            bom,
            tree,
            totalCost: Math.round(totalCost * 100) / 100,
            leafMaterials: Object.values(leafMaterials),
            versionCount
        }
    });
});

/**
 * POST /api/boms
 */
router.post('/', requirePermission('boms', 'add'), (req, res) => {
    const db = getDB();
    const { name, outputMaterialId, outputQuantity = 1, category, description, status = 'active', items = [] } = req.body;

    if (!name || !name.trim()) throw new ValidationError('BOM 名称不能为空');

    const { fullPinyin, abbr } = generatePinyinFields(name.trim());

    if (outputMaterialId) {
        const mat = db.prepare('SELECT id FROM materials WHERE id = ? AND is_active = 1').get(outputMaterialId);
        if (!mat) throw new NotFoundError('产出物料');
    }

    const doCreate = db.transaction(() => {
        const code = generateBomCode(db);
        const result = db.prepare(`
            INSERT INTO boms (name, code, output_material_id, output_quantity, category, description, status, name_pinyin, name_pinyin_abbr, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(name.trim(), code, outputMaterialId || null, outputQuantity, category || null, description || null, status, fullPinyin, abbr, req.session.user.id);

        const bomId = result.lastInsertRowid;

        // 插入 BOM 项
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.materialId && !item.subBomId) continue;

            // 防止引用自身
            if (item.subBomId && item.subBomId == bomId) {
                throw new ValidationError('BOM 不能引用自身');
            }

            db.prepare(`
                INSERT INTO bom_items (bom_id, material_id, sub_bom_id, quantity, position, loss_rate, allow_substitution, substitution_priority, notes, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(bomId, item.materialId || null, item.subBomId || null, item.quantity || 1, item.position || null, item.lossRate || 0, item.allowSubstitution ? 1 : 0, item.substitutionPriority || 1, item.notes || null, i);
        }
        return { bomId, code };
    });

    const { bomId, code } = doCreate();

    logOperation({
        userId: req.session.user.id, action: 'create', resource: 'boms',
        resourceId: bomId, detail: `创建 BOM: ${name} (${code})`, ip: req.ip
    });

    res.status(201).json({ success: true, data: { id: bomId, code } });
});

/**
 * PUT /api/boms/:id
 */
router.put('/:id', requirePermission('boms', 'edit'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const { name, outputMaterialId, outputQuantity, category, description, status, items = [], changeNotes } = req.body;

    if (!name || !name.trim()) throw new ValidationError('BOM 名称不能为空');
    if (status && status !== 'active') {
        const snapshotRefs = findBomSnapshotReferences(db, bom.id);
        if (snapshotRefs.length > 0) {
            const sampleOrders = snapshotRefs.slice(0, 5).map(order => order.order_no).join('、');
            throw new ValidationError(`该BOM已被 ${snapshotRefs.length} 张工单快照引用${sampleOrders ? `（${sampleOrders}）` : ''}，无法改为非 active 状态`);
        }
    }

    const { fullPinyin, abbr } = generatePinyinFields(name.trim());

    const doUpdate = db.transaction(() => {
        // 保存版本快照
        const currentItems = db.prepare('SELECT * FROM bom_items WHERE bom_id = ? ORDER BY sort_order').all(bom.id);
        const snapshot = JSON.stringify({
            name: bom.name, code: bom.code, version: bom.version,
            outputMaterialId: bom.output_material_id, outputQuantity: bom.output_quantity,
            category: bom.category, description: bom.description,
            items: currentItems
        });

        db.prepare(`
            INSERT INTO bom_versions (bom_id, version, snapshot, change_notes, created_by)
            VALUES (?, ?, ?, ?, ?)
        `).run(bom.id, bom.version, snapshot, changeNotes || null, req.session.user.id);

        // 自动递增版本号
        let newVersion = bom.version;
        const parts = bom.version.split('.');
        if (parts.length >= 2) {
            parts[parts.length - 1] = String(parseInt(parts[parts.length - 1]) + 1);
            newVersion = parts.join('.');
        } else {
            newVersion = bom.version + '.1';
        }

        // 更新 BOM 主表
        db.prepare(`
            UPDATE boms SET name=?, output_material_id=?, output_quantity=?, category=?, description=?,
                            status=?, version=?, name_pinyin=?, name_pinyin_abbr=?, updated_at=datetime('now','localtime')
            WHERE id = ?
        `).run(name.trim(), outputMaterialId || null, outputQuantity || 1, category || null, description || null,
               status || 'active', newVersion, fullPinyin, abbr, bom.id);

        // 重建 BOM 项
        db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(bom.id);

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.materialId && !item.subBomId) continue;

            if (item.subBomId && item.subBomId == bom.id) {
                throw new ValidationError('BOM 不能引用自身');
            }

            db.prepare(`
                INSERT INTO bom_items (bom_id, material_id, sub_bom_id, quantity, position, loss_rate, allow_substitution, substitution_priority, notes, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(bom.id, item.materialId || null, item.subBomId || null, item.quantity || 1, item.position || null, item.lossRate || 0, item.allowSubstitution ? 1 : 0, item.substitutionPriority || 1, item.notes || null, i);
        }

        // 验证无循环引用
        try {
            expandBom(db, bom.id);
        } catch (err) {
            throw new ValidationError('保存失败: ' + err.message);
        }

        return newVersion;
    });

    const newVersion = doUpdate();

    logOperation({
        userId: req.session.user.id, action: 'update', resource: 'boms',
        resourceId: bom.id, detail: `更新 BOM: ${name} → v${newVersion}`, ip: req.ip
    });

    res.json({ success: true, data: { version: newVersion } });
});

/**
 * DELETE /api/boms/:id
 */
router.delete('/:id', requirePermission('boms', 'delete'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const snapshotRefs = findBomSnapshotReferences(db, bom.id);
    if (snapshotRefs.length > 0) {
        const sampleOrders = snapshotRefs.slice(0, 5).map(order => order.order_no).join('、');
        throw new ValidationError(`该BOM已被 ${snapshotRefs.length} 张工单快照引用${sampleOrders ? `（${sampleOrders}）` : ''}，无法删除`);
    }

    // 检查是否被其他 BOM 引用为子件
    const usedBy = db.prepare(`
        SELECT b.name, b.code FROM bom_items bi JOIN boms b ON bi.bom_id = b.id
        WHERE bi.sub_bom_id = ? AND b.is_active = 1
    `).all(bom.id);

    if (usedBy.length > 0) {
        throw new ValidationError(`该 BOM 被以下 BOM 引用为子件，无法删除: ${usedBy.map(b => b.name).join('、')}`);
    }

    db.prepare("UPDATE boms SET is_active = 0, updated_at = datetime('now','localtime') WHERE id = ?").run(bom.id);

    logOperation({
        userId: req.session.user.id, action: 'delete', resource: 'boms',
        resourceId: bom.id, detail: `删除 BOM: ${bom.name} (${bom.code})`, ip: req.ip
    });

    res.json({ success: true });
});

/**
 * POST /api/boms/:id/duplicate
 */
router.post('/:id/duplicate', requirePermission('boms', 'add'), (req, res) => {
    const db = getDB();
    const src = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!src) throw new NotFoundError('BOM');

    const newName = `${src.name} (副本)`;
    const { fullPinyin, abbr } = generatePinyinFields(newName);

    const doDuplicate = db.transaction(() => {
        const code = generateBomCode(db);
        const result = db.prepare(`
            INSERT INTO boms (name, code, output_material_id, output_quantity, category, description, status, name_pinyin, name_pinyin_abbr, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(newName, code, src.output_material_id, src.output_quantity, src.category, src.description, fullPinyin, abbr, req.session.user.id);

        const newId = result.lastInsertRowid;
        const items = db.prepare('SELECT * FROM bom_items WHERE bom_id = ? ORDER BY sort_order').all(src.id);

        for (const item of items) {
            db.prepare(`
                INSERT INTO bom_items (bom_id, material_id, sub_bom_id, quantity, position, loss_rate, allow_substitution, substitution_priority, notes, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(newId, item.material_id, item.sub_bom_id, item.quantity, item.position, item.loss_rate, item.allow_substitution ? 1 : 0, item.substitution_priority || 1, item.notes, item.sort_order);
        }

        return { newId, code };
    });

    const { newId, code } = doDuplicate();

    logOperation({
        userId: req.session.user.id, action: 'create', resource: 'boms',
        resourceId: newId, detail: `复制 BOM: ${src.name} → ${newName}`, ip: req.ip
    });

    res.status(201).json({ success: true, data: { id: newId, code } });
});

/**
 * GET /api/boms/where-used/:materialId
 * 物料反查：查看某物料在哪些 BOM 中使用
 */
router.get('/where-used/:materialId', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const materialId = parseInt(req.params.materialId);

    const material = db.prepare('SELECT id, name, code FROM materials WHERE id = ?').get(materialId);
    if (!material) throw new NotFoundError('物料');

    // 直接引用
    const directUsage = db.prepare(`
        SELECT b.id, b.name, b.code, b.version, b.status, bi.quantity, bi.position, bi.loss_rate
        FROM bom_items bi
        JOIN boms b ON bi.bom_id = b.id
        WHERE bi.material_id = ? AND b.is_active = 1
        ORDER BY b.name
    `).all(materialId);

    // 间接引用（通过子 BOM）
    const indirectUsage = [];
    const bomsContainingMaterial = new Set(directUsage.map(u => u.id));

    // 查找哪些 BOM 将包含该物料的 BOM 作为子件
    function findParentBoms(bomIds, depth = 0) {
        if (depth > 10 || bomIds.size === 0) return;
        const parentItems = db.prepare(`
            SELECT DISTINCT b.id, b.name, b.code, b.version, b.status, bi.sub_bom_id
            FROM bom_items bi
            JOIN boms b ON bi.bom_id = b.id
            WHERE bi.sub_bom_id IN (${Array.from(bomIds).join(',')}) AND b.is_active = 1
        `).all();

        const newParentIds = new Set();
        for (const p of parentItems) {
            if (!bomsContainingMaterial.has(p.id)) {
                bomsContainingMaterial.add(p.id);
                indirectUsage.push({ ...p, via_bom_id: p.sub_bom_id });
                newParentIds.add(p.id);
            }
        }
        if (newParentIds.size > 0) findParentBoms(newParentIds, depth + 1);
    }

    findParentBoms(bomsContainingMaterial);

    res.json({
        success: true,
        data: {
            material,
            directUsage,
            indirectUsage,
            totalBoms: bomsContainingMaterial.size
        }
    });
});

/**
 * GET /api/boms/:id/versions
 */
router.get('/:id/versions', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT id, name FROM boms WHERE id = ?').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const versions = db.prepare(`
        SELECT bv.*, u.display_name as creator_name
        FROM bom_versions bv
        LEFT JOIN users u ON bv.created_by = u.id
        WHERE bv.bom_id = ?
        ORDER BY bv.created_at DESC
    `).all(bom.id);

    res.json({ success: true, data: { bom, versions } });
});

/**
 * POST /api/boms/:id/restore/:versionId
 */
router.post('/:id/restore/:versionId', requirePermission('boms', 'edit'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const version = db.prepare('SELECT * FROM bom_versions WHERE id = ? AND bom_id = ?').get(req.params.versionId, bom.id);
    if (!version) throw new NotFoundError('版本');

    const snapshot = JSON.parse(version.snapshot);

    const doRestore = db.transaction(() => {
        // 先保存当前版本
        const currentItems = db.prepare('SELECT * FROM bom_items WHERE bom_id = ?').all(bom.id);
        db.prepare(`
            INSERT INTO bom_versions (bom_id, version, snapshot, change_notes, created_by)
            VALUES (?, ?, ?, ?, ?)
        `).run(bom.id, bom.version, JSON.stringify({
            name: bom.name, code: bom.code, version: bom.version,
            outputMaterialId: bom.output_material_id, outputQuantity: bom.output_quantity,
            category: bom.category, description: bom.description, items: currentItems
        }), `恢复前自动备份 (恢复目标: v${version.version})`, req.session.user.id);

        // 恢复 BOM 主表
        const { fullPinyin, abbr } = generatePinyinFields(snapshot.name);
        db.prepare(`
            UPDATE boms SET name=?, output_material_id=?, output_quantity=?, category=?, description=?,
                            version=?, name_pinyin=?, name_pinyin_abbr=?, updated_at=datetime('now','localtime')
            WHERE id = ?
        `).run(snapshot.name, snapshot.outputMaterialId || null, snapshot.outputQuantity || 1,
               snapshot.category || null, snapshot.description || null,
               version.version + '-restored', fullPinyin, abbr, bom.id);

        // 恢复 BOM 项
        db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(bom.id);
        for (const item of snapshot.items) {
            db.prepare(`
                INSERT INTO bom_items (bom_id, material_id, sub_bom_id, quantity, position, loss_rate, notes, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(bom.id, item.material_id, item.sub_bom_id, item.quantity, item.position, item.loss_rate, item.notes, item.sort_order);
        }
    });

    doRestore();

    logOperation({
        userId: req.session.user.id, action: 'update', resource: 'boms',
        resourceId: bom.id, detail: `恢复 BOM: ${bom.name} 到版本 v${version.version}`, ip: req.ip
    });

    res.json({ success: true });
});

/**
 * GET /api/boms/:id/cost
 * 详细成本分析
 */
router.get('/:id/cost', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const tree = expandBom(db, bom.id, bom.output_quantity || 1);
    const flatItems = flattenBom(tree);

    const totalCost = tree.reduce((sum, item) => sum + (item.line_cost || 0), 0);

    // 按分类汇总成本
    const costByCategory = {};
    for (const item of flatItems) {
        if (!item.is_sub_bom && item.material_id) {
            const cat = item.spec || '未分类';
            if (!costByCategory[cat]) costByCategory[cat] = 0;
            costByCategory[cat] += item.line_cost || 0;
        }
    }

    // 成本排名 (TOP 物料)
    const leafMaterials = {};
    for (const item of flatItems) {
        if (!item.is_sub_bom && item.material_id) {
            if (!leafMaterials[item.material_id]) {
                leafMaterials[item.material_id] = {
                    name: item.material_name, code: item.material_code,
                    unit: item.unit, cost_price: item.cost_price,
                    total_quantity: 0, total_cost: 0
                };
            }
            leafMaterials[item.material_id].total_quantity += item.actual_quantity;
            leafMaterials[item.material_id].total_cost += item.line_cost || 0;
        }
    }

    const costRanking = Object.values(leafMaterials)
        .sort((a, b) => b.total_cost - a.total_cost)
        .map((m, i) => ({ ...m, rank: i + 1, percentage: totalCost > 0 ? Math.round(m.total_cost / totalCost * 10000) / 100 : 0 }));

    res.json({
        success: true,
        data: {
            bom,
            totalCost: Math.round(totalCost * 100) / 100,
            unitCost: bom.output_quantity > 0 ? Math.round(totalCost / bom.output_quantity * 100) / 100 : totalCost,
            costByCategory,
            costRanking,
            materialCount: Object.keys(leafMaterials).length
        }
    });
});

/**
 * GET /api/boms/:id/check?quantity=N&warehouseId=X
 * 根据 BOM 检查生产指定数量所需物料的库存是否充足
 */
router.get('/:id/check', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const produceQty = Math.max(1, parseInt(req.query.quantity) || 1);
    const warehouseId = req.query.warehouseId || null;

    // 展开 BOM 树，按生产数量计算实际用量
    const tree = expandBom(db, bom.id, produceQty);
    const flatItems = flattenBom(tree);

    // 汇总叶子物料需求
    const materialNeeds = {};
    for (const item of flatItems) {
        if (!item.is_sub_bom && item.material_id) {
            if (!materialNeeds[item.material_id]) {
                materialNeeds[item.material_id] = {
                    material_id: item.material_id,
                    material_name: item.material_name,
                    material_code: item.material_code,
                    unit: item.unit,
                    spec: item.spec,
                    required: 0
                };
            }
            materialNeeds[item.material_id].required += item.actual_quantity;
        }
    }

    // 查库存
    const results = [];
    let allSufficient = true;
    for (const need of Object.values(materialNeeds)) {
        let stockQuery = 'SELECT COALESCE(SUM(quantity), 0) as total FROM inventory WHERE material_id = ?';
        const params = [need.material_id];
        if (warehouseId) {
            stockQuery += ' AND warehouse_id = ?';
            params.push(warehouseId);
        }
        const stock = db.prepare(stockQuery).get(...params);
        const available = stock.total;
        const required = Math.ceil(need.required);
        const sufficient = available >= required;
        const shortage = sufficient ? 0 : required - available;

        if (!sufficient) allSufficient = false;

        results.push({
            ...need,
            required,
            available,
            sufficient,
            shortage,
            supplyRisk: getMaterialSupplyRiskContext(db, need.material_id, warehouseId)
        });
    }

    // 按缺口大小排序（缺料的排前面）
    results.sort((a, b) => b.shortage - a.shortage);

    res.json({
        success: true,
        data: {
            bom: { id: bom.id, name: bom.name, code: bom.code },
            produceQuantity: produceQty,
            allSufficient,
            totalMaterials: results.length,
            shortageCount: results.filter(r => !r.sufficient).length,
            highRiskShortageCount: results.filter(r => !r.sufficient && ['critical', 'high'].includes(r.supplyRisk?.riskLevel)).length,
            materials: results
        }
    });
});

module.exports = router;
