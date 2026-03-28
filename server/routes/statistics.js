/**
 * 统计与报表路由
 * GET /api/statistics/dashboard         - 仪表盘概览
 * GET /api/statistics/low-stock         - 低库存预警
 * GET /api/statistics/trends            - 出入库趋势（折线图）
 * GET /api/statistics/inventory-report  - 库存报表
 * GET /api/statistics/movement-report   - 出入库流水报表
 * GET /api/statistics/shipment-report   - 发货统计报表
 * GET /api/statistics/category-stock    - 分类库存占比（饼图）
 * GET /api/statistics/top-materials     - 物料排行（出库最多/库存价值最高）
 * GET /api/statistics/warehouse-compare - 仓库库存对比
 */

const express = require('express');
const ExcelJS = require('exceljs');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

function hasColumn(db, tableName, columnName) {
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);
    if (!row) return false;
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.some(column => column.name === columnName);
}

function setDownloadHeaders(res, filename, contentType) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-cache');
}

function toCSV(headers, rows) {
    const bom = '\uFEFF';
    const headerLine = headers.map(h => `"${h.label}"`).join(',');
    const dataLines = rows.map(row =>
        headers.map(h => {
            let val = row[h.key];
            if (val === null || val === undefined) val = '';
            val = String(val).replace(/"/g, '""');
            return `"${val}"`;
        }).join(',')
    );
    return bom + [headerLine, ...dataLines].join('\r\n');
}

async function toExcel(sheetName, headers, rows) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OvO System';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = headers.map(h => ({
        header: h.label,
        key: h.key,
        width: h.width || 16
    }));
    rows.forEach(row => {
        const normalized = {};
        headers.forEach(h => {
            normalized[h.key] = row[h.key] ?? '';
        });
        sheet.addRow(normalized);
    });
    const headerRow = sheet.getRow(1);
    headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    return workbook;
}

// ============================================
// 辅助函数
// ============================================

/**
 * 生成日期序列 [startDate ... endDate]
 */
function generateDateRange(startDate, endDate) {
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

/**
 * 解析通用日期范围参数
 * ?range=7d | 30d | 90d | custom&start=YYYY-MM-DD&end=YYYY-MM-DD
 */
function parseDateRange(query) {
    const range = query.range || '30d';
    let endDate = new Date();
    let startDate = new Date();

    if (range === 'custom' && query.start && query.end) {
        startDate = new Date(query.start);
        endDate = new Date(query.end);
    } else {
        const days = parseInt(range) || 30;
        startDate.setDate(endDate.getDate() - days + 1);
    }

    return {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
    };
}

function buildMovementFilterContext(query) {
    const { start, end } = parseDateRange(query);
    const {
        type,
        warehouseId,
        toWarehouseId,
        materialId,
        source,
        referenceNo,
        counterparty
    } = query;

    const whereClauses = ['date(sm.created_at) BETWEEN ? AND ?'];
    const params = [start, end];

    if (type) { whereClauses.push('sm.type = ?'); params.push(type); }
    if (warehouseId) { whereClauses.push('sm.warehouse_id = ?'); params.push(warehouseId); }
    if (toWarehouseId) { whereClauses.push('sm.to_warehouse_id = ?'); params.push(toWarehouseId); }
    if (materialId) { whereClauses.push('sm.material_id = ?'); params.push(materialId); }
    if (source) { whereClauses.push('sm.source = ?'); params.push(source); }
    if (referenceNo) { whereClauses.push('sm.reference_no LIKE ?'); params.push(`%${referenceNo}%`); }
    if (counterparty) { whereClauses.push('sm.counterparty LIKE ?'); params.push(`%${counterparty}%`); }

    return {
        start,
        end,
        whereSQL: whereClauses.join(' AND '),
        params
    };
}

function reversalExpr() {
    return 'COALESCE(sd.is_reversal, 0)';
}

function actionMovementFilterSQL(alias = 'sm') {
    return `COALESCE(${alias}.source_doc_type, '') != 'legacy_movement'`;
}

function getShipmentBusinessDateSQL(alias = 's') {
    return `
        CASE
            WHEN ${alias}.status IN ('shipped', 'delivered') THEN COALESCE(NULLIF(${alias}.shipped_at, ''), ${alias}.created_at)
            WHEN ${alias}.status = 'cancelled' THEN COALESCE(${alias}.updated_at, ${alias}.created_at)
            ELSE ${alias}.created_at
        END
    `;
}

function getWarningThresholdExpr(alias = 'm') {
    return `COALESCE(NULLIF(${alias}.safety_stock, 0), NULLIF(${alias}.min_stock, 0), 0)`;
}

function getMaterialStockMap(db) {
    const rows = db.prepare(`
        SELECT material_id, COALESCE(SUM(quantity), 0) as total_stock
        FROM inventory
        GROUP BY material_id
    `).all();
    return new Map(rows.map(row => [Number(row.material_id), Number(row.total_stock || 0)]));
}

function getKitCoverageItems(db, limit = 8) {
    const stockMap = getMaterialStockMap(db);
    const activeBomRows = db.prepare(`
        SELECT *
        FROM boms
        WHERE is_active = 1 AND status = 'active'
        ORDER BY updated_at DESC, id DESC
    `).all();
    const bomById = new Map(activeBomRows.map(row => [Number(row.id), row]));
    const latestBomByOutputMaterialId = new Map();
    activeBomRows.forEach(row => {
        if (row.output_material_id && !latestBomByOutputMaterialId.has(Number(row.output_material_id))) {
            latestBomByOutputMaterialId.set(Number(row.output_material_id), row);
        }
    });

    const bomItemsByBomId = new Map();
    db.prepare(`
        SELECT bi.*,
               m.name as material_name,
               m.code as material_code,
               m.unit as material_unit
        FROM bom_items bi
        LEFT JOIN materials m ON bi.material_id = m.id
        ORDER BY bi.sort_order, bi.id
    `).all().forEach(row => {
        const key = Number(row.bom_id);
        if (!bomItemsByBomId.has(key)) bomItemsByBomId.set(key, []);
        bomItemsByBomId.get(key).push(row);
    });

    function collectLeafRequirements(bomId, multiplier = 1, visited = new Set()) {
        const numericBomId = Number(bomId);
        if (!numericBomId || visited.has(numericBomId)) return [];
        const bom = bomById.get(numericBomId);
        if (!bom) return [];
        const outputQty = Number(bom.output_quantity || 1) || 1;
        const items = bomItemsByBomId.get(numericBomId) || [];
        const nextVisited = new Set(visited);
        nextVisited.add(numericBomId);
        const leaves = [];

        items.forEach(item => {
            const baseQty = Number(item.quantity || 0) * (1 + Number(item.loss_rate || 0) / 100) * multiplier;
            if (item.sub_bom_id) {
                const childBom = bomById.get(Number(item.sub_bom_id));
                const childOutputQty = Number(childBom?.output_quantity || 1) || 1;
                leaves.push(...collectLeafRequirements(item.sub_bom_id, baseQty / childOutputQty, nextVisited));
            } else if (item.material_id && baseQty > 0) {
                leaves.push({
                    materialId: Number(item.material_id),
                    materialName: item.material_name,
                    materialCode: item.material_code,
                    unit: item.material_unit,
                    requiredQty: baseQty / outputQty
                });
            }
        });

        return leaves;
    }

    const candidates = db.prepare(`
        SELECT m.id, m.code, m.name, m.unit, m.material_type, m.target_coverage_qty, m.default_bom_id
        FROM materials m
        WHERE m.is_active = 1
          AND COALESCE(m.target_coverage_qty, 0) > 0
        ORDER BY m.target_coverage_qty DESC, m.updated_at DESC
    `).all();

    const coverageItems = [];
    for (const material of candidates) {
        const bom = material.default_bom_id
            ? bomById.get(Number(material.default_bom_id))
            : latestBomByOutputMaterialId.get(Number(material.id));
        if (!bom) continue;

        const leaves = collectLeafRequirements(bom.id);
        if (!leaves.length) continue;

        const aggregated = new Map();
        leaves.forEach(leaf => {
            const key = Number(leaf.materialId);
            const current = aggregated.get(key) || {
                materialId: key,
                materialName: leaf.materialName,
                materialCode: leaf.materialCode,
                unit: leaf.unit,
                requiredQty: 0
            };
            current.requiredQty += Number(leaf.requiredQty || 0);
            aggregated.set(key, current);
        });

        const bottlenecks = [];
        let producibleQty = Number.POSITIVE_INFINITY;
        aggregated.forEach(item => {
            const available = Number(stockMap.get(item.materialId) || 0);
            const supported = item.requiredQty > 0 ? Math.floor(available / item.requiredQty) : Number.POSITIVE_INFINITY;
            const normalizedSupported = Number.isFinite(supported) ? Math.max(supported, 0) : 0;
            if (normalizedSupported < producibleQty) producibleQty = normalizedSupported;
            bottlenecks.push({
                ...item,
                availableQty: available,
                supportedQty: normalizedSupported
            });
        });

        if (!Number.isFinite(producibleQty)) producibleQty = 0;
        const targetCoverageQty = Number(material.target_coverage_qty || 0);
        const shortageQty = Math.max(targetCoverageQty - producibleQty, 0);
        if (shortageQty <= 0) continue;

        bottlenecks.sort((a, b) => a.supportedQty - b.supportedQty || a.availableQty - b.availableQty);
        coverageItems.push({
            material_id: Number(material.id),
            code: material.code,
            name: material.name,
            unit: material.unit,
            material_type: material.material_type,
            target_coverage_qty: targetCoverageQty,
            producible_qty: producibleQty,
            shortage_qty: shortageQty,
            bom_id: Number(bom.id),
            bom_code: bom.code,
            bottlenecks: bottlenecks.slice(0, 3)
        });
    }

    coverageItems.sort((a, b) => b.shortage_qty - a.shortage_qty || a.producible_qty - b.producible_qty);
    return {
        count: coverageItems.length,
        items: coverageItems.slice(0, limit)
    };
}

function getMaterialDailyConsumptionMap(db, days = 30) {
    const safeDays = Math.max(1, Number(days || 30));
    const modifier = `-${safeDays} days`;
    const map = new Map();
    db.prepare(`
        SELECT sm.material_id, SUM(ABS(sm.quantity)) as total_out_qty
        FROM stock_movements sm
        WHERE sm.type = 'out'
          AND datetime(sm.created_at) >= datetime('now', 'localtime', ?)
        GROUP BY sm.material_id
    `).all(modifier).forEach(row => {
        map.set(Number(row.material_id), Number(row.total_out_qty || 0) / safeDays);
    });
    return map;
}

function getSupplyRiskLevel(score) {
    if (score >= 90) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    return 'normal';
}

function buildSupplyRiskProcurementAdvice(item) {
    const advice = {
        urgency: 'normal',
        actionLabel: '持续观察',
        primaryAction: '持续观察供应风险变化',
        buyerHint: '保持例行跟踪'
    };
    if (item.riskLevel === 'critical' || (item.coverageRiskGapDays !== null && item.coverageRiskGapDays > 0)) {
        advice.urgency = 'urgent';
        advice.actionLabel = '采购任务';
        advice.primaryAction = '建议立即生成采购任务并锁定交期';
        advice.buyerHint = '优先联系供应商确认可交期、可供数量和替代渠道';
    } else if (item.riskLevel === 'high' || item.singleSource || item.effectiveLeadTimeDays >= 7) {
        advice.urgency = 'high';
        advice.actionLabel = '采购跟进';
        advice.primaryAction = '建议生成采购跟进任务';
        advice.buyerHint = '尽快核对库存覆盖、交期缓冲和备料计划';
    } else if (!item.hasSubstitution) {
        advice.urgency = 'medium';
        advice.actionLabel = '备料任务';
        advice.primaryAction = '建议生成备料/替代料治理任务';
        advice.buyerHint = '补第二来源或替代工艺路线';
    }
    return advice;
}

function getSupplyRiskLookupMap(db) {
    return new Map(getSupplyRiskItems(db, { limit: 1000, onlyWarning: false }).items.map(item => [Number(item.materialId), item]));
}

function enrichKitCoverageItemsWithRisk(items, riskMap) {
    return (items || []).map(item => ({
        ...item,
        bottlenecks: (item.bottlenecks || []).map(bottleneck => {
            const risk = riskMap.get(Number(bottleneck.materialId));
            return {
                ...bottleneck,
                isSingleSource: !!risk?.singleSource,
                effectiveLeadTimeDays: risk?.effectiveLeadTimeDays || 0,
                riskLevel: risk?.riskLevel || 'normal',
                riskScore: risk?.riskScore || 0,
                procurementAdvice: risk?.procurementAdvice || null,
                recommendedActions: risk?.recommendedActions || []
            };
        })
    }));
}

function enrichProductionExceptionTopMaterials(items, riskMap) {
    return (items || []).map(item => {
        const risk = riskMap.get(Number(item.id));
        return {
            ...item,
            supplyRisk: risk ? {
                riskLevel: risk.riskLevel,
                riskScore: risk.riskScore,
                singleSource: risk.singleSource,
                effectiveLeadTimeDays: risk.effectiveLeadTimeDays,
                hasSubstitution: risk.hasSubstitution,
                recommendedActions: risk.recommendedActions || [],
                procurementAdvice: risk.procurementAdvice || null
            } : null
        };
    });
}

function getSupplyRiskItems(db, options = {}) {
    const limit = Math.max(1, Number(options.limit || 20));
    const onlyWarning = options.onlyWarning !== false;
    const search = String(options.search || '').trim().toLowerCase();
    const safetyBufferDays = Math.max(0, Number(options.safetyBufferDays ?? 3));
    const consumptionDays = Math.max(1, Number(options.consumptionDays || 30));
    const governanceStatus = String(options.governanceStatus || '').trim();
    const governanceClosure = String(options.closure || 'all').trim();
    const governanceOwner = String(options.owner || '').trim().toLowerCase();
    const actionTypeFilter = String(options.actionType || '').trim();
    const stockMap = getMaterialStockMap(db);
    const dailyConsumptionMap = getMaterialDailyConsumptionMap(db, consumptionDays);
    const kitCoverageMap = new Map(getKitCoverageItems(db, 1000).items.map(item => [Number(item.material_id), item]));
    const governanceMap = getSupplyRiskGovernanceMap(db);
    const supplierSummaryMap = new Map();
    if (hasTable(db, 'material_suppliers')) {
        db.prepare(`
            SELECT ms.material_id,
                   COUNT(*) as supplier_count,
                   MAX(CASE WHEN ms.is_default = 1 THEN ms.supplier_name END) as default_supplier_name,
                   MAX(CASE WHEN ms.is_default = 1 THEN ms.source_platform END) as default_source_platform,
                   MAX(CASE WHEN ms.is_default = 1 THEN ms.lead_time_days END) as default_lead_time_days
            FROM material_suppliers ms
            GROUP BY ms.material_id
        `).all().forEach(row => supplierSummaryMap.set(Number(row.material_id), row));
    }

    const substitutionCountMap = new Map();
    if (hasTable(db, 'material_substitutions')) {
        db.prepare(`
            SELECT material_id, COUNT(*) as substitution_count
            FROM material_substitutions
            WHERE COALESCE(is_active, 1) = 1
            GROUP BY material_id
        `).all().forEach(row => substitutionCountMap.set(Number(row.material_id), Number(row.substitution_count || 0)));
    }

    const items = db.prepare(`
        SELECT m.id, m.code, m.name, m.unit, m.material_type, m.is_key_part,
               m.min_stock, m.safety_stock, m.reorder_point, m.target_coverage_qty,
               m.is_single_source, m.coverage_days_target, m.supply_risk_level, m.supply_risk_notes,
               m.lead_time_days, m.is_active
        FROM materials m
        WHERE m.is_active = 1
        ORDER BY m.updated_at DESC, m.id DESC
    `).all().map(material => {
        const supplierSummary = supplierSummaryMap.get(Number(material.id)) || {};
        const supplierCount = Number(supplierSummary.supplier_count || 0);
        const hasSubstitution = Number(substitutionCountMap.get(Number(material.id)) || 0) > 0;
        const effectiveLeadTimeDays = Number(
            supplierSummary.default_lead_time_days || material.lead_time_days || 0
        );
        const currentStock = Number(stockMap.get(Number(material.id)) || 0);
        const avgDailyConsumption = Number(dailyConsumptionMap.get(Number(material.id)) || 0);
        const coverageDays = avgDailyConsumption > 0 ? currentStock / avgDailyConsumption : null;
        const targetCoverageDays = Number(material.coverage_days_target || 0);
        const coverageRiskGapDays = coverageDays === null
            ? null
            : Number((effectiveLeadTimeDays + safetyBufferDays - coverageDays).toFixed(2));
        const warningThreshold = Number(material.safety_stock || material.min_stock || 0);
        const reorderPoint = Number(material.reorder_point || 0);
        const singleSource = Number(material.is_single_source || 0) === 1 || supplierCount === 1;
        const kitCoverage = kitCoverageMap.get(Number(material.id)) || null;
        const reasons = [];
        let score = 0;

        if (singleSource) {
            score += 40;
            reasons.push('唯一供应商');
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
        if (!hasSubstitution) {
            score += 25;
            reasons.push('无替代料');
        }
        if (Number(material.is_key_part || 0) === 1) {
            score += 25;
            reasons.push('关键件');
        }
        if (warningThreshold > 0 && currentStock <= warningThreshold) {
            score += 20;
            reasons.push('低于安全阈值');
        }
        if (reorderPoint > 0 && currentStock <= reorderPoint) {
            score += 15;
            reasons.push('低于补货点');
        }
        if (kitCoverage && Number(kitCoverage.shortage_qty || 0) > 0) {
            score += 30;
            reasons.push(`无法满足保供套数，缺 ${kitCoverage.shortage_qty} 套`);
        }
        if (coverageDays !== null && effectiveLeadTimeDays > 0 && coverageDays < (effectiveLeadTimeDays + safetyBufferDays)) {
            score += 25;
            reasons.push(`库存仅够 ${coverageDays.toFixed(1)} 天，低于交期+缓冲 ${effectiveLeadTimeDays + safetyBufferDays} 天`);
        }
        if (coverageDays !== null && targetCoverageDays > 0 && coverageDays < targetCoverageDays) {
            score += 15;
            reasons.push(`库存仅够 ${coverageDays.toFixed(1)} 天，低于目标保供天数 ${targetCoverageDays} 天`);
        }
        if (['taobao', '1688', 'jd', 'pdd', 'wechat', 'other'].includes(String(supplierSummary.default_source_platform || ''))) {
            score += 10;
            reasons.push('来源平台波动风险');
        }

        const riskLevel = getSupplyRiskLevel(score);
        const recommendedActions = [];
        if (singleSource) recommendedActions.push('优先核对唯一供应商交期并准备替代渠道');
        if (effectiveLeadTimeDays >= 7) recommendedActions.push('提前发起采购或备料计划');
        if (!hasSubstitution) recommendedActions.push('尽快维护替代料或替代工艺路线');
        if (kitCoverage && Number(kitCoverage.shortage_qty || 0) > 0) recommendedActions.push('结合保供套数预警优先补齐瓶颈料');
        if (coverageDays !== null && effectiveLeadTimeDays > 0 && coverageDays < (effectiveLeadTimeDays + safetyBufferDays)) {
            recommendedActions.push('当前库存覆盖不足以穿越交期，建议立即评估补货');
        }
        const item = {
            materialId: Number(material.id),
            code: material.code,
            name: material.name,
            unit: material.unit,
            materialType: material.material_type,
            currentStock,
            warningThreshold,
            reorderPoint,
            targetCoverageQty: Number(material.target_coverage_qty || 0),
            singleSource,
            supplierCount,
            defaultSupplierName: supplierSummary.default_supplier_name || null,
            defaultSourcePlatform: supplierSummary.default_source_platform || null,
            effectiveLeadTimeDays,
            avgDailyConsumption,
            coverageDays,
            coverageDaysTarget: targetCoverageDays,
            coverageRiskGapDays,
            safetyBufferDays,
            hasSubstitution,
            isKeyPart: Number(material.is_key_part || 0) === 1,
            kitCoverage,
            riskScore: score,
            riskLevel,
            riskReasons: reasons,
            riskNotes: material.supply_risk_notes || null,
            recommendedActions
        };
        const governance = governanceMap.get(Number(material.id)) || null;
        const governanceMeta = getSupplyRiskGovernanceMeta(governance?.status);
        return {
            ...item,
            procurementAdvice: buildSupplyRiskProcurementAdvice(item),
            governanceStatus: governance?.status || 'open',
            governanceStatusLabel: governanceMeta.label,
            governanceOwner: governance?.owner || '',
            governanceNotes: governance?.notes || '',
            governanceUpdatedAt: governance?.updated_at || null,
            governanceUpdatedByName: governance?.updated_by_name || null,
            governanceActionType: governance?.action_type || '',
            governanceActionLabel: governance?.action_type === 'staging'
                ? '备料任务'
                : governance?.action_type === 'substitution'
                    ? '替代治理任务'
                    : '采购任务',
            governanceSourceContext: governance?.source_context || null,
            governanceIsProcessed: governanceMeta.isProcessed
        };
    }).filter(item => onlyWarning ? item.riskLevel !== 'normal' : true)
        .filter(item => {
            if (!search) return true;
            return String(item.code || '').toLowerCase().includes(search)
                || String(item.name || '').toLowerCase().includes(search);
        })
        .filter(item => {
            if (options.riskLevel && item.riskLevel !== options.riskLevel) return false;
            if (options.singleSource === true && !item.singleSource) return false;
            if (options.singleSource === false && item.singleSource) return false;
            if (options.isKeyPart === true && !item.isKeyPart) return false;
            if (options.isKeyPart === false && item.isKeyPart) return false;
            if (options.hasSubstitution === true && !item.hasSubstitution) return false;
            if (options.hasSubstitution === false && item.hasSubstitution) return false;
            if (options.sourcePlatform && String(item.defaultSourcePlatform || '') !== String(options.sourcePlatform)) return false;
            if (options.leadTimeBucket === 'gte7' && item.effectiveLeadTimeDays < 7) return false;
            if (options.leadTimeBucket === 'gte14' && item.effectiveLeadTimeDays < 14) return false;
            if (options.leadTimeBucket === 'gte30' && item.effectiveLeadTimeDays < 30) return false;
            if (governanceStatus && item.governanceStatus !== governanceStatus) return false;
            if (governanceClosure === 'open' && item.governanceIsProcessed) return false;
            if (governanceClosure === 'processed' && !item.governanceIsProcessed) return false;
            if (governanceOwner && !String(item.governanceOwner || '').toLowerCase().includes(governanceOwner)) return false;
            if (actionTypeFilter && String(item.governanceActionType || '') !== actionTypeFilter) return false;
            return true;
        })
        .sort((a, b) => {
            const levelWeight = { critical: 0, high: 1, medium: 2, normal: 3 };
            return (levelWeight[a.riskLevel] - levelWeight[b.riskLevel])
                || (b.riskScore - a.riskScore)
                || (b.effectiveLeadTimeDays - a.effectiveLeadTimeDays)
                || a.code.localeCompare(b.code, 'zh-Hans-CN');
        });

    const summary = {
        totalCount: items.length,
        criticalCount: items.filter(item => item.riskLevel === 'critical').length,
        highCount: items.filter(item => item.riskLevel === 'high').length,
        mediumCount: items.filter(item => item.riskLevel === 'medium').length,
        singleSourceCount: items.filter(item => item.singleSource).length,
        longLeadTimeCount: items.filter(item => item.effectiveLeadTimeDays >= 7).length,
        keyPartCount: items.filter(item => item.isKeyPart).length,
        noSubstitutionCount: items.filter(item => !item.hasSubstitution).length,
        coverageGapCount: items.filter(item => item.coverageRiskGapDays !== null && item.coverageRiskGapDays > 0).length,
        governanceOpenCount: items.filter(item => item.governanceStatus === 'open').length,
        governanceInProgressCount: items.filter(item => item.governanceStatus === 'in_progress').length,
        governanceProcessedCount: items.filter(item => ['resolved', 'ignored'].includes(item.governanceStatus)).length,
        procurementTaskCount: items.filter(item => item.governanceActionType === 'procurement').length,
        stagingTaskCount: items.filter(item => item.governanceActionType === 'staging').length,
        substitutionTaskCount: items.filter(item => item.governanceActionType === 'substitution').length
    };

    return {
        summary,
        items: items.slice(0, limit)
    };
}

function getDocumentKeySQL() {
    return "COALESCE(NULLIF(sm.source_doc_no, ''), NULLIF(sm.reference_no, ''), 'MOV-' || sm.id)";
}

function hasTable(db, tableName) {
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);
    return !!row;
}

function buildDocumentSummaryFromRows(rows) {
    if (!rows.length) return null;
    const first = rows[0];
    const totalQuantity = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const totalAmount = rows.reduce((sum, row) => sum + Number(row.total_price || 0), 0);
    const materialIds = [...new Set(rows.map(row => row.material_id).filter(Boolean))];
    const warehouseIds = [...new Set(rows.map(row => row.warehouse_id).filter(Boolean))];
    const toWarehouseIds = [...new Set(rows.map(row => row.to_warehouse_id).filter(Boolean))];
    const movementIds = rows.map(row => row.id);

    return {
        documentNo: first.source_doc_no || first.reference_no || `MOV-${first.id}`,
        documentStatus: first.doc_status || 'posted',
        documentType: first.source_doc_type || 'movement_execution',
        bizType: first.biz_type || first.source || 'manual_execution',
        sourceLabel: first.source_label || first.source || '-',
        movementCount: rows.length,
        movementIds,
        materialCount: materialIds.length,
        warehouseCount: warehouseIds.length,
        toWarehouseCount: toWarehouseIds.length,
        materialName: materialIds.length === 1 ? first.material_name : `${materialIds.length} 种物料`,
        materialCode: materialIds.length === 1 ? first.material_code : null,
        warehouseName: warehouseIds.length === 1 ? first.warehouse_name : `${warehouseIds.length} 个源仓`,
        toWarehouseName: toWarehouseIds.length === 1 ? (first.to_warehouse_name || '-') : (toWarehouseIds.length ? `${toWarehouseIds.length} 个目标仓` : '-'),
        quantity: totalQuantity,
        unit: materialIds.length === 1 ? first.unit : '',
        totalAmount,
        counterparty: first.counterparty || null,
        beforeQuantity: first.before_quantity,
        actualQuantity: first.actual_quantity,
        delta: totalQuantity,
        executedAt: first.executed_at || first.created_at,
        notes: rows.map(row => row.notes).filter(Boolean)[0] || '',
        movements: rows.map(row => ({
            id: row.id,
            type: row.type,
            quantity: row.quantity,
            unit: row.unit,
            warehouseName: row.warehouse_name,
            toWarehouseName: row.to_warehouse_name || null,
            materialName: row.material_name,
            materialCode: row.material_code,
            counterparty: row.counterparty,
            referenceNo: row.reference_no,
            sourceLabel: row.source_label || row.source || '-',
            documentStatus: row.doc_status || 'posted',
            executedAt: row.executed_at || row.created_at,
            notes: row.notes,
            unitPrice: row.unit_price,
            totalPrice: row.total_price,
            beforeQuantity: row.before_quantity,
            actualQuantity: row.actual_quantity
        }))
    };
}

function getProductionExceptionStats(db, start, end) {
    if (!hasTable(db, 'production_exceptions')) {
        return {
            summary: { totalCount: 0, totalQuantity: 0, byType: {}, byDirection: { in: 0, out: 0 } },
            reversalSummary: { totalCount: 0, totalQuantity: 0 },
            trend: [],
            topMaterials: []
        };
    }

    const hasStatus = hasColumn(db, 'production_exceptions', 'status');
    const hasReversal = hasColumn(db, 'production_exceptions', 'is_reversal');
    const normalClauses = ['date(pe.created_at) BETWEEN ? AND ?'];
    const reversalClauses = ['date(pe.created_at) BETWEEN ? AND ?'];
    if (hasStatus) {
        normalClauses.push("COALESCE(pe.status, 'posted') = 'posted'");
        reversalClauses.push("COALESCE(pe.status, 'posted') = 'posted'");
    }
    if (hasReversal) {
        normalClauses.push('COALESCE(pe.is_reversal, 0) = 0');
        reversalClauses.push('COALESCE(pe.is_reversal, 0) = 1');
    }
    const normalWhere = normalClauses.join(' AND ');
    const reversalWhere = reversalClauses.join(' AND ');

    const summaryRows = db.prepare(`
        SELECT
            pe.exception_type,
            pe.direction,
            COUNT(*) as total_count,
            COALESCE(SUM(pe.quantity), 0) as total_quantity
        FROM production_exceptions pe
        WHERE ${normalWhere}
        GROUP BY pe.exception_type, pe.direction
    `).all(start, end);

    const reversalSummaryRow = db.prepare(`
        SELECT COUNT(*) as total_count, COALESCE(SUM(pe.quantity), 0) as total_quantity
        FROM production_exceptions pe
        WHERE ${reversalWhere}
    `).get(start, end);

    const trendRows = db.prepare(`
        SELECT
            date(pe.created_at) as day,
            pe.exception_type,
            COUNT(*) as total_count,
            COALESCE(SUM(pe.quantity), 0) as total_quantity
        FROM production_exceptions pe
        WHERE ${normalWhere}
        GROUP BY day, pe.exception_type
        ORDER BY day
    `).all(start, end);

    const topMaterials = db.prepare(`
        SELECT
            pe.material_id as id,
            m.name,
            m.code,
            m.unit,
            COUNT(*) as exception_count,
            COALESCE(SUM(pe.quantity), 0) as total_qty
        FROM production_exceptions pe
        LEFT JOIN materials m ON pe.material_id = m.id
        WHERE ${normalWhere}
        GROUP BY pe.material_id, m.name, m.code, m.unit
        ORDER BY total_qty DESC, exception_count DESC, pe.material_id DESC
        LIMIT 10
    `).all(start, end);

    const summary = {
        totalCount: summaryRows.reduce((sum, row) => sum + Number(row.total_count || 0), 0),
        totalQuantity: summaryRows.reduce((sum, row) => sum + Number(row.total_quantity || 0), 0),
        byType: { scrap: 0, supplement: 0, over_issue: 0, variance: 0 },
        byDirection: { in: 0, out: 0 }
    };

    summaryRows.forEach(row => {
        const type = row.exception_type;
        const direction = row.direction;
        summary.byType[type] = {
            count: Number(row.total_count || 0),
            quantity: Number(row.total_quantity || 0),
            direction
        };
        summary.byDirection[direction] = Number(summary.byDirection[direction] || 0) + Number(row.total_quantity || 0);
    });

    const riskMap = getSupplyRiskLookupMap(db);
    return {
        summary,
        reversalSummary: {
            totalCount: Number(reversalSummaryRow?.total_count || 0),
            totalQuantity: Number(reversalSummaryRow?.total_quantity || 0)
        },
        trend: trendRows,
        topMaterials: enrichProductionExceptionTopMaterials(topMaterials, riskMap)
    };
}

function getSubstitutionJoinSQL(alias = 'sm') {
    return `
        LEFT JOIN stock_document_items sdi
          ON sdi.id = (
              SELECT sdi2.id
              FROM stock_document_items sdi2
              WHERE sdi2.document_id = ${alias}.source_doc_id
                AND sdi2.material_id = ${alias}.material_id
              ORDER BY sdi2.line_no ASC, sdi2.id ASC
              LIMIT 1
          )
        LEFT JOIN materials om ON om.id = sdi.original_material_id
    `;
}

function getInventoryConsistencySummary(db) {
    const detail = getInventoryConsistencyDetails(db, { page: 1, limit: 1 });
    return detail.summary;
}

function getInventoryConsistencyRecommendations(summary) {
    const recommendations = [];
    if (summary.negativeCount > 0) {
        recommendations.push({
            type: 'negative',
            severity: 'blocking',
            title: '先清理负库存',
            description: `当前有 ${summary.negativeCount} 条负库存记录。优先核对是否存在漏录入库、重复出库、历史迁移差异或应补红冲单。`
        });
    }
    if (summary.mismatchCount > 0) {
        recommendations.push({
            type: 'mismatch',
            severity: 'blocking',
            title: '核对余额与流水口径',
            description: `当前有 ${summary.mismatchCount} 个库存余额与流水净额不一致组合。建议按物料+仓库追查期初、调拨、盘点和手工修正来源。`
        });
    }
    if (summary.noMovementBaselineCount > 0) {
        recommendations.push({
            type: 'no-baseline',
            severity: 'warning',
            title: '补标准化历史基线',
            description: `当前有 ${summary.noMovementBaselineCount} 条库存余额没有对应流水。建议逐步沉淀为期初库存单或标准迁移基线记录。`
        });
    }
    if (!recommendations.length) {
        recommendations.push({
            type: 'healthy',
            severity: 'ok',
            title: '当前一致性可继续验收',
            description: '未发现阻塞性库存一致性问题，可以继续做业务验收和上线准备。'
        });
    }
    return recommendations;
}

function buildInventoryConsistencyIssueKey(issueType, materialId, warehouseId) {
    return `${issueType}:${Number(materialId)}:${Number(warehouseId)}`;
}

function getInventoryConsistencyGovernanceMeta(status) {
    const normalized = String(status || 'open').trim() || 'open';
    const map = {
        open: { label: '待处理', isProcessed: false },
        in_progress: { label: '处理中', isProcessed: false },
        resolved: { label: '已处理', isProcessed: true },
        ignored: { label: '已忽略', isProcessed: true }
    };
    return map[normalized] || map.open;
}

function getInventoryConsistencyGovernanceMap(db) {
    if (!hasColumn(db, 'inventory_consistency_governance', 'issue_key')) return new Map();
    const rows = db.prepare(`
        SELECT icg.*, u.display_name as updated_by_name
        FROM inventory_consistency_governance icg
        LEFT JOIN users u ON u.id = icg.updated_by
    `).all();
    return new Map(rows.map(row => [row.issue_key, row]));
}

function getSupplyRiskGovernanceMeta(status) {
    const normalized = String(status || 'open').trim() || 'open';
    const map = {
        open: { label: '待处理', isProcessed: false },
        in_progress: { label: '处理中', isProcessed: false },
        resolved: { label: '已处理', isProcessed: true },
        ignored: { label: '已忽略', isProcessed: true }
    };
    return map[normalized] || map.open;
}

function getSupplyRiskGovernanceMap(db) {
    if (!hasColumn(db, 'supply_risk_governance', 'material_id')) return new Map();
    const rows = db.prepare(`
        SELECT srg.*, u.display_name as updated_by_name
        FROM supply_risk_governance srg
        LEFT JOIN users u ON u.id = srg.updated_by
    `).all();
    return new Map(rows.map(row => [Number(row.material_id), row]));
}

function getInventoryConsistencyDetails(db, options = {}) {
    const issueType = (options.issueType || 'all').trim();
    const warehouseId = Number(options.warehouseId || 0);
    const page = Math.max(Number(options.page || 1), 1);
    const limit = Math.max(1, Math.min(Number(options.limit || 20), 200));
    const keyword = String(options.search || '').trim().toLowerCase();
    const governanceStatus = String(options.governanceStatus || '').trim();
    const governanceOwner = String(options.owner || '').trim().toLowerCase();
    const governanceClosure = String(options.closure || 'all').trim();

    const mismatchRows = db.prepare(`
        WITH movement_balance AS (
            SELECT
                material_id,
                warehouse_id,
                SUM(delta_qty) as movement_qty
            FROM (
                SELECT material_id, warehouse_id, quantity as delta_qty
                FROM stock_movements
                WHERE type IN ('in', 'adjust')
                UNION ALL
                SELECT material_id, warehouse_id, -quantity as delta_qty
                FROM stock_movements
                WHERE type = 'out'
                UNION ALL
                SELECT material_id, warehouse_id, -quantity as delta_qty
                FROM stock_movements
                WHERE type = 'transfer'
                UNION ALL
                SELECT material_id, to_warehouse_id as warehouse_id, quantity as delta_qty
                FROM stock_movements
                WHERE type = 'transfer' AND to_warehouse_id IS NOT NULL
            )
            GROUP BY material_id, warehouse_id
        )
        SELECT
            i.material_id,
            i.warehouse_id,
            m.code as material_code,
            m.name as material_name,
            m.spec as material_spec,
            m.unit as material_unit,
            w.name as warehouse_name,
            i.quantity as inventory_qty,
            COALESCE(mb.movement_qty, 0) as movement_qty,
            i.quantity - COALESCE(mb.movement_qty, 0) as gap_qty
        FROM inventory i
        LEFT JOIN materials m ON m.id = i.material_id
        LEFT JOIN warehouses w ON w.id = i.warehouse_id
        LEFT JOIN movement_balance mb
          ON mb.material_id = i.material_id
         AND mb.warehouse_id = i.warehouse_id
        WHERE i.quantity != COALESCE(mb.movement_qty, 0)
    `).all();

    const negativeRows = db.prepare(`
        SELECT
            i.material_id,
            i.warehouse_id,
            m.code as material_code,
            m.name as material_name,
            m.spec as material_spec,
            m.unit as material_unit,
            w.name as warehouse_name,
            i.quantity as inventory_qty
        FROM inventory i
        LEFT JOIN materials m ON m.id = i.material_id
        LEFT JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.quantity < 0
    `).all();

    const noMovementBaselineRows = db.prepare(`
        SELECT
            i.material_id,
            i.warehouse_id,
            m.code as material_code,
            m.name as material_name,
            m.spec as material_spec,
            m.unit as material_unit,
            w.name as warehouse_name,
            i.quantity as inventory_qty
        FROM inventory i
        LEFT JOIN materials m ON m.id = i.material_id
        LEFT JOIN warehouses w ON w.id = i.warehouse_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM stock_movements sm
            WHERE sm.material_id = i.material_id
              AND (sm.warehouse_id = i.warehouse_id OR sm.to_warehouse_id = i.warehouse_id)
        )
    `).all();

    const governanceMap = getInventoryConsistencyGovernanceMap(db);

    const issues = [
        ...negativeRows.map(row => ({
            issueKey: buildInventoryConsistencyIssueKey('negative', row.material_id, row.warehouse_id),
            issueType: 'negative',
            issueTypeLabel: '负库存',
            severity: 'blocking',
            severityLabel: '阻塞',
            materialId: Number(row.material_id),
            materialCode: row.material_code,
            materialName: row.material_name,
            materialSpec: row.material_spec,
            materialUnit: row.material_unit,
            warehouseId: Number(row.warehouse_id),
            warehouseName: row.warehouse_name,
            inventoryQty: Number(row.inventory_qty || 0),
            movementQty: null,
            gapQty: null,
            reason: '账面库存已小于 0，需要优先核对补录、红冲或历史差异。',
            sortValue: Math.abs(Number(row.inventory_qty || 0))
        })),
        ...mismatchRows.map(row => ({
            issueKey: buildInventoryConsistencyIssueKey('mismatch', row.material_id, row.warehouse_id),
            issueType: 'mismatch',
            issueTypeLabel: '余额/流水不一致',
            severity: 'blocking',
            severityLabel: '阻塞',
            materialId: Number(row.material_id),
            materialCode: row.material_code,
            materialName: row.material_name,
            materialSpec: row.material_spec,
            materialUnit: row.material_unit,
            warehouseId: Number(row.warehouse_id),
            warehouseName: row.warehouse_name,
            inventoryQty: Number(row.inventory_qty || 0),
            movementQty: Number(row.movement_qty || 0),
            gapQty: Number(row.gap_qty || 0),
            reason: '库存余额与流水净额不一致，需要排查期初、调拨、盘点或历史修正记录。',
            sortValue: Math.abs(Number(row.gap_qty || 0))
        })),
        ...noMovementBaselineRows.map(row => ({
            issueKey: buildInventoryConsistencyIssueKey('no-baseline', row.material_id, row.warehouse_id),
            issueType: 'no-baseline',
            issueTypeLabel: '无流水历史基线',
            severity: 'warning',
            severityLabel: '观察',
            materialId: Number(row.material_id),
            materialCode: row.material_code,
            materialName: row.material_name,
            materialSpec: row.material_spec,
            materialUnit: row.material_unit,
            warehouseId: Number(row.warehouse_id),
            warehouseName: row.warehouse_name,
            inventoryQty: Number(row.inventory_qty || 0),
            movementQty: 0,
            gapQty: Number(row.inventory_qty || 0),
            reason: '当前库存有余额，但没有找到对应流水，通常代表历史期初或迁移基线未标准化。',
            sortValue: Math.abs(Number(row.inventory_qty || 0))
        }))
    ].map(item => {
        const governance = governanceMap.get(item.issueKey);
        const governanceStatusValue = governance?.status || 'open';
        const governanceMeta = getInventoryConsistencyGovernanceMeta(governanceStatusValue);
        return {
            ...item,
            id: item.issueKey,
            governanceStatus: governanceStatusValue,
            governanceStatusLabel: governanceMeta.label,
            governanceOwner: governance?.owner || '',
            governanceNotes: governance?.notes || '',
            governanceUpdatedAt: governance?.updated_at || null,
            governanceUpdatedByName: governance?.updated_by_name || null,
            isProcessed: governanceMeta.isProcessed
        };
    });

    const filteredIssues = issues
        .filter(item => issueType === 'all' || item.issueType === issueType)
        .filter(item => !warehouseId || item.warehouseId === warehouseId)
        .filter(item => !governanceStatus || item.governanceStatus === governanceStatus)
        .filter(item => {
            if (governanceClosure === 'all') return true;
            return governanceClosure === 'processed' ? item.isProcessed : !item.isProcessed;
        })
        .filter(item => {
            if (!governanceOwner) return true;
            return String(item.governanceOwner || '').toLowerCase().includes(governanceOwner);
        })
        .filter(item => {
            if (!keyword) return true;
            const text = [
                item.materialCode,
                item.materialName,
                item.materialSpec,
                item.warehouseName,
                item.issueTypeLabel,
                item.reason,
                item.governanceOwner,
                item.governanceNotes
            ].filter(Boolean).join(' ').toLowerCase();
            return text.includes(keyword);
        })
        .sort((a, b) => {
            const severityWeight = { blocking: 0, warning: 1 };
            return (severityWeight[a.severity] - severityWeight[b.severity])
                || (b.sortValue - a.sortValue)
                || String(a.materialCode || '').localeCompare(String(b.materialCode || ''), 'zh-Hans-CN');
        });

    const total = filteredIssues.length;
    const startIndex = (page - 1) * limit;
    const pagedItems = filteredIssues.slice(startIndex, startIndex + limit);

    const summary = {
        negativeCount: negativeRows.length,
        noMovementBaselineCount: noMovementBaselineRows.length,
        mismatchCount: mismatchRows.length,
        blockingCount: negativeRows.length + mismatchRows.length,
        governanceOpenCount: issues.filter(item => item.governanceStatus === 'open').length,
        governanceInProgressCount: issues.filter(item => item.governanceStatus === 'in_progress').length,
        governanceResolvedCount: issues.filter(item => item.governanceStatus === 'resolved').length,
        governanceIgnoredCount: issues.filter(item => item.governanceStatus === 'ignored').length,
        governanceProcessedCount: issues.filter(item => item.isProcessed).length,
        sample: mismatchRows.slice(0, 20).map(row => ({
            material_id: row.material_id,
            warehouse_id: row.warehouse_id,
            inventory_qty: Number(row.inventory_qty || 0),
            movement_qty: Number(row.movement_qty || 0),
            gap_qty: Number(row.gap_qty || 0)
        }))
    };

    return {
        summary,
        recommendations: getInventoryConsistencyRecommendations(summary),
        issueSummary: [
            { type: 'all', label: '全部问题', count: issues.length, severity: 'mixed' },
            { type: 'negative', label: '负库存', count: negativeRows.length, severity: 'blocking' },
            { type: 'mismatch', label: '余额/流水不一致', count: mismatchRows.length, severity: 'blocking' },
            { type: 'no-baseline', label: '无流水历史基线', count: noMovementBaselineRows.length, severity: 'warning' }
        ],
        governanceSummary: [
            { status: 'open', label: '待处理', count: issues.filter(item => item.governanceStatus === 'open').length },
            { status: 'in_progress', label: '处理中', count: issues.filter(item => item.governanceStatus === 'in_progress').length },
            { status: 'resolved', label: '已处理', count: issues.filter(item => item.governanceStatus === 'resolved').length },
            { status: 'ignored', label: '已忽略', count: issues.filter(item => item.governanceStatus === 'ignored').length }
        ],
        items: pagedItems,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit))
        }
    };
}


// ============================================
// GET /api/statistics/dashboard
// 仪表盘概览数据
// ============================================
router.get('/dashboard', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();
    const consistency = getInventoryConsistencySummary(db);
    const kitCoverage = getKitCoverageItems(db, 6);
    const supplyRisk = getSupplyRiskItems(db, { limit: 6 });
    const supplyRiskMap = getSupplyRiskLookupMap(db);
    const enrichedKitCoverageItems = enrichKitCoverageItemsWithRisk(kitCoverage.items || [], supplyRiskMap);

    const materialCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM materials WHERE is_active = 1'
    ).get().cnt;

    const warehouseCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM warehouses WHERE is_active = 1'
    ).get().cnt;

    const pendingShipments = db.prepare(
        "SELECT COUNT(*) as cnt FROM shipments WHERE status IN ('pending', 'confirmed')"
    ).get().cnt;

    const lowStockCount = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM (
            SELECT m.id
            FROM materials m
            LEFT JOIN inventory i ON m.id = i.material_id
            WHERE m.is_active = 1
            GROUP BY m.id
            HAVING ${getWarningThresholdExpr('m')} > 0
               AND COALESCE(SUM(i.quantity), 0) <= ${getWarningThresholdExpr('m')}
        )
    `).get().cnt;

    const todayIn = db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as total
        FROM stock_movements
        WHERE type = 'in' AND date(created_at) = date('now', 'localtime')
    `).get().total;

    const todayOut = db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as total
        FROM stock_movements
        WHERE type = 'out' AND date(created_at) = date('now', 'localtime')
    `).get().total;

    const totalValue = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN i.quantity > 0 THEN i.quantity * m.cost_price ELSE 0 END), 0) as total
        FROM inventory i
        JOIN materials m ON i.material_id = m.id
        WHERE i.quantity > 0
    `).get().total;

    const recentLogs = db.prepare(`
        SELECT ol.*, u.display_name as user_name
        FROM operation_logs ol
        LEFT JOIN users u ON ol.user_id = u.id
        ORDER BY ol.created_at DESC
        LIMIT 5
    `).all();

    const productionExceptionCount = hasTable(db, 'production_exceptions')
        ? db.prepare('SELECT COUNT(*) as cnt FROM production_exceptions').get().cnt
        : 0;

    const productionExceptionToday = hasTable(db, 'production_exceptions')
        ? db.prepare(`
            SELECT COUNT(*) as cnt
            FROM production_exceptions
            WHERE date(created_at) = date('now', 'localtime')
        `).get().cnt
        : 0;

    res.json({
        success: true,
        data: {
            materialCount, warehouseCount, pendingShipments, lowStockCount,
            todayIn, todayOut, totalValue, recentLogs,
            productionExceptionCount,
            productionExceptionToday,
            kitCoverageCount: kitCoverage.count,
            kitCoverageItems: enrichedKitCoverageItems,
            supplyRiskCount: supplyRisk.summary.totalCount,
            supplyRiskSummary: supplyRisk.summary,
            supplyRiskItems: supplyRisk.items,
            inventoryConsistency: consistency
        }
    });
});


// ============================================
// GET /api/statistics/low-stock
// 低库存预警明细
// ============================================
router.get('/low-stock', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();

    const items = db.prepare(`
        SELECT m.id, m.code, m.name, m.unit, m.min_stock, m.safety_stock, m.supplier,
               COALESCE(SUM(i.quantity), 0) as total_stock,
               ${getWarningThresholdExpr('m')} as warning_threshold,
               ${getWarningThresholdExpr('m')} - COALESCE(SUM(i.quantity), 0) as shortage
        FROM materials m
        LEFT JOIN inventory i ON m.id = i.material_id
        WHERE m.is_active = 1
        GROUP BY m.id
        HAVING warning_threshold > 0
           AND total_stock <= warning_threshold
        ORDER BY shortage DESC
    `).all();

    res.json({ success: true, data: { items, count: items.length } });
});

router.get('/kit-coverage', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const data = getKitCoverageItems(db, limit);
    const riskMap = getSupplyRiskLookupMap(db);
    data.items = enrichKitCoverageItemsWithRisk(data.items || [], riskMap);
    res.json({ success: true, data });
});

router.get('/supply-risk-summary', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 50));
    const data = getSupplyRiskItems(db, { limit, onlyWarning: true });
    res.json({ success: true, data });
});

router.get('/supply-risk-items', requirePermission('reports', 'view'), (req, res) => {
    const db = getDB();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const onlyWarning = req.query.onlyWarning !== '0';
    const riskLevel = String(req.query.riskLevel || '').trim() || null;
    const sourcePlatform = String(req.query.sourcePlatform || '').trim() || null;
    const leadTimeBucket = String(req.query.leadTimeBucket || '').trim() || null;
    const search = String(req.query.search || '').trim() || null;
    const singleSource = req.query.singleSource === '' || req.query.singleSource === undefined
        ? null
        : req.query.singleSource === '1';
    const isKeyPart = req.query.isKeyPart === '' || req.query.isKeyPart === undefined
        ? null
        : req.query.isKeyPart === '1';
    const hasSubstitution = req.query.hasSubstitution === '' || req.query.hasSubstitution === undefined
        ? null
        : req.query.hasSubstitution === '1';
    const governanceStatus = String(req.query.governanceStatus || '').trim() || null;
    const closure = String(req.query.closure || 'all').trim() || 'all';
    const owner = String(req.query.owner || '').trim() || null;
    const actionType = String(req.query.actionType || '').trim() || null;
    const data = getSupplyRiskItems(db, {
        limit: 1000,
        onlyWarning,
        riskLevel,
        sourcePlatform,
        leadTimeBucket,
        search,
        singleSource,
        isKeyPart,
        hasSubstitution,
        governanceStatus,
        closure,
        owner,
        actionType
    });
    res.json({
        success: true,
        data: {
            summary: data.summary,
            items: data.items.slice(0, limit)
        }
    });
});

router.post('/supply-risk/governance', requirePermission('reports', 'edit'), (req, res) => {
    const db = getDB();
    const materialId = Number(req.body?.materialId || 0);
    const actionType = String(req.body?.actionType || 'procurement').trim();
    const status = String(req.body?.status || 'open').trim();
    const owner = String(req.body?.owner || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const sourceContext = String(req.body?.sourceContext || '').trim();
    const allowedStatuses = new Set(['open', 'in_progress', 'resolved', 'ignored']);
    const allowedActionTypes = new Set(['procurement', 'staging', 'substitution']);

    if (!materialId) {
        return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: '缺少物料标识' }
        });
    }
    if (!allowedStatuses.has(status)) {
        return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: '治理状态不合法' }
        });
    }
    if (!allowedActionTypes.has(actionType)) {
        return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: '治理动作类型不合法' }
        });
    }

    db.prepare(`
        INSERT INTO supply_risk_governance (
            material_id, action_type, status, owner, notes, source_context, updated_by, resolved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('resolved', 'ignored') THEN datetime('now', 'localtime') ELSE NULL END, datetime('now', 'localtime'))
        ON CONFLICT(material_id) DO UPDATE SET
            action_type = excluded.action_type,
            status = excluded.status,
            owner = excluded.owner,
            notes = excluded.notes,
            source_context = excluded.source_context,
            updated_by = excluded.updated_by,
            resolved_at = CASE
                WHEN excluded.status IN ('resolved', 'ignored') THEN datetime('now', 'localtime')
                ELSE NULL
            END,
            updated_at = datetime('now', 'localtime')
    `).run(
        materialId,
        actionType,
        status,
        owner || null,
        notes || null,
        sourceContext || null,
        req.session.user.id,
        status
    );

    const row = db.prepare(`
        SELECT srg.*, u.display_name as updated_by_name
        FROM supply_risk_governance srg
        LEFT JOIN users u ON u.id = srg.updated_by
        WHERE srg.material_id = ?
    `).get(materialId);
    const meta = getSupplyRiskGovernanceMeta(row?.status);
    return res.json({
        success: true,
        data: {
            item: {
                materialId,
                governanceStatus: row?.status || 'open',
                governanceStatusLabel: meta.label,
                governanceOwner: row?.owner || '',
                governanceNotes: row?.notes || '',
                governanceUpdatedAt: row?.updated_at || null,
                governanceUpdatedByName: row?.updated_by_name || null,
                governanceActionType: row?.action_type || '',
                governanceSourceContext: row?.source_context || null,
                governanceIsProcessed: meta.isProcessed
            }
        }
    });
});


// ============================================
// GET /api/statistics/trends
// 出入库趋势（按天聚合，折线图数据）
// ============================================
router.get('/trends', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();
    const { start, end } = parseDateRange(req.query);
    const productionExceptionStats = getProductionExceptionStats(db, start, end);

    const movements = db.prepare(`
        SELECT
            date(sm.created_at) as day,
            sm.type,
            ${reversalExpr()} as is_reversal,
            COALESCE(SUM(sm.quantity), 0) as total_qty,
            COALESCE(SUM(sm.total_price), 0) as total_amount
        FROM stock_movements sm
        LEFT JOIN stock_documents sd ON sm.source_doc_id = sd.id
        WHERE date(sm.created_at) BETWEEN ? AND ?
          AND sm.type IN ('in', 'out')
          AND ${actionMovementFilterSQL('sm')}
        GROUP BY day, sm.type, ${reversalExpr()}
        ORDER BY day
    `).all(start, end);

    // 填充完整日期序列
    const dates = generateDateRange(start, end);
    const normalInData = [];
    const normalOutData = [];
    const reversalInData = [];
    const reversalOutData = [];
    const normalInAmount = [];
    const normalOutAmount = [];
    const reversalInAmount = [];
    const reversalOutAmount = [];

    const movementMap = {};
    movements.forEach(m => {
        const key = `${m.day}_${m.type}_${m.is_reversal ? 'reversal' : 'normal'}`;
        movementMap[key] = m;
    });

    dates.forEach(d => {
        const normalInRow = movementMap[`${d}_in_normal`];
        const normalOutRow = movementMap[`${d}_out_normal`];
        const reversalInRow = movementMap[`${d}_in_reversal`];
        const reversalOutRow = movementMap[`${d}_out_reversal`];

        normalInData.push(normalInRow ? normalInRow.total_qty : 0);
        normalOutData.push(normalOutRow ? normalOutRow.total_qty : 0);
        reversalInData.push(reversalInRow ? reversalInRow.total_qty : 0);
        reversalOutData.push(reversalOutRow ? reversalOutRow.total_qty : 0);
        normalInAmount.push(normalInRow ? normalInRow.total_amount : 0);
        normalOutAmount.push(normalOutRow ? normalOutRow.total_amount : 0);
        reversalInAmount.push(reversalInRow ? reversalInRow.total_amount : 0);
        reversalOutAmount.push(reversalOutRow ? reversalOutRow.total_amount : 0);
    });

    const normalSummary = {
        totalIn: normalInData.reduce((a, b) => a + b, 0),
        totalOut: normalOutData.reduce((a, b) => a + b, 0),
        totalInAmount: normalInAmount.reduce((a, b) => a + b, 0),
        totalOutAmount: normalOutAmount.reduce((a, b) => a + b, 0)
    };

    const reversalSummary = {
        totalIn: reversalInData.reduce((a, b) => a + b, 0),
        totalOut: reversalOutData.reduce((a, b) => a + b, 0),
        totalInAmount: reversalInAmount.reduce((a, b) => a + b, 0),
        totalOutAmount: reversalOutAmount.reduce((a, b) => a + b, 0)
    };

    const exceptionMap = {};
    productionExceptionStats.trend.forEach(row => {
        exceptionMap[`${row.day}_${row.exception_type}`] = row;
    });
    const exceptionTotalCount = [];
    const exceptionTotalQty = [];
    const exceptionByType = {
        scrap: [],
        supplement: [],
        over_issue: [],
        variance: []
    };
    dates.forEach(d => {
        let dayCount = 0;
        let dayQty = 0;
        Object.keys(exceptionByType).forEach(type => {
            const row = exceptionMap[`${d}_${type}`];
            const count = row ? Number(row.total_count || 0) : 0;
            const qty = row ? Number(row.total_quantity || 0) : 0;
            exceptionByType[type].push(qty);
            dayCount += count;
            dayQty += qty;
        });
        exceptionTotalCount.push(dayCount);
        exceptionTotalQty.push(dayQty);
    });

    res.json({
        success: true,
        data: {
            labels: dates,
            datasets: {
                inQty: normalInData,
                outQty: normalOutData,
                inAmount: normalInAmount,
                outAmount: normalOutAmount,
                normalInQty: normalInData,
                normalOutQty: normalOutData,
                reversalInQty: reversalInData,
                reversalOutQty: reversalOutData,
                normalInAmount,
                normalOutAmount,
                reversalInAmount,
                reversalOutAmount,
                productionExceptionQty: exceptionTotalQty,
                productionExceptionScrapQty: exceptionByType.scrap,
                productionExceptionSupplementQty: exceptionByType.supplement,
                productionExceptionOverIssueQty: exceptionByType.over_issue,
                productionExceptionVarianceQty: exceptionByType.variance
            },
            summary: normalSummary,
            normalSummary,
            reversalSummary,
            productionExceptionSummary: productionExceptionStats.summary,
            productionExceptionReversalSummary: productionExceptionStats.reversalSummary,
            productionExceptionTrend: {
                labels: dates,
                totalCount: exceptionTotalCount,
                totalQty: exceptionTotalQty,
                byTypeQty: exceptionByType
            },
            combinedSummary: {
                totalIn: normalSummary.totalIn + reversalSummary.totalIn,
                totalOut: normalSummary.totalOut + reversalSummary.totalOut,
                totalInAmount: normalSummary.totalInAmount + reversalSummary.totalInAmount,
                totalOutAmount: normalSummary.totalOutAmount + reversalSummary.totalOutAmount
            }
        }
    });
});


// ============================================
// GET /api/statistics/inventory-report
// 库存报表（每种物料在各仓库的库存详情）
// ============================================
router.get('/inventory-report', requirePermission('reports', 'view'), (req, res) => {
    const db = getDB();
    const { warehouseId, categoryId, search } = req.query;

    let sql = `
        SELECT m.id, m.code, m.name, m.unit, m.spec, m.category_id,
               c.name as category_name, m.cost_price, m.sale_price,
               m.min_stock, m.supplier,
               w.id as warehouse_id, w.name as warehouse_name,
               COALESCE(i.quantity, 0) as quantity
        FROM materials m
        LEFT JOIN categories c ON m.category_id = c.id
        CROSS JOIN warehouses w
        LEFT JOIN inventory i ON m.id = i.material_id AND w.id = i.warehouse_id
        WHERE m.is_active = 1 AND w.is_active = 1
    `;
    const params = [];

    if (warehouseId) { sql += ' AND w.id = ?'; params.push(warehouseId); }
    if (categoryId) { sql += ' AND m.category_id = ?'; params.push(categoryId); }
    if (search) { sql += ' AND (m.name LIKE ? OR m.code LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    sql += ' ORDER BY m.code, w.name';

    const rows = db.prepare(sql).all(...params);

    // 聚合按物料
    const materialMap = {};
    rows.forEach(r => {
        if (!materialMap[r.id]) {
            materialMap[r.id] = {
                id: r.id, code: r.code, name: r.name, unit: r.unit, spec: r.spec,
                category_name: r.category_name, cost_price: r.cost_price,
                sale_price: r.sale_price, min_stock: r.min_stock, supplier: r.supplier,
                total_stock: 0, total_value: 0,
                warehouses: []
            };
        }
        materialMap[r.id].warehouses.push({
            warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name, quantity: r.quantity
        });
        materialMap[r.id].total_stock += r.quantity;
        if (r.quantity > 0) {
            materialMap[r.id].total_value += r.quantity * r.cost_price;
        }
    });

    const items = Object.values(materialMap);
    const grandTotalQty = items.reduce((s, i) => s + i.total_stock, 0);
    const grandTotalValue = items.reduce((s, i) => s + i.total_value, 0);

    res.json({
        success: true,
        data: {
            items,
            summary: { totalMaterials: items.length, totalQuantity: grandTotalQty, totalValue: grandTotalValue }
        }
    });
});


// ============================================
// GET /api/statistics/movement-report
// 出入库流水报表
// ============================================
router.get('/movement-report', requirePermission('reports', 'view'), (req, res) => {
    const db = getDB();
    const { start, end, whereSQL, params } = buildMovementFilterContext(req.query);
    const productionExceptionStats = getProductionExceptionStats(db, start, end);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    const total = db.prepare(`
        SELECT COUNT(*) as cnt FROM stock_movements sm WHERE ${whereSQL}
    `).get(...params).cnt;

    const items = db.prepare(`
        SELECT sm.*, m.name as material_name, m.code as material_code, m.unit,
               w.name as warehouse_name, tw.name as to_warehouse_name, u.display_name as operator_name,
               ${reversalExpr()} as is_reversal,
               parent.doc_no as reversal_of_doc_no,
               sdi.original_material_id,
               sdi.substitution_type,
               sdi.substitution_reason,
               om.name as original_material_name,
               om.code as original_material_code
        FROM stock_movements sm
        LEFT JOIN materials m ON sm.material_id = m.id
        LEFT JOIN warehouses w ON sm.warehouse_id = w.id
        LEFT JOIN warehouses tw ON sm.to_warehouse_id = tw.id
        LEFT JOIN users u ON sm.created_by = u.id
        LEFT JOIN stock_documents sd ON sm.source_doc_id = sd.id
        LEFT JOIN stock_documents parent ON sd.reversal_of_document_id = parent.id
        ${getSubstitutionJoinSQL('sm')}
        WHERE ${whereSQL}
        ORDER BY sm.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    // 汇总
    const summary = db.prepare(`
        SELECT type,
               COUNT(*) as count,
               COALESCE(SUM(quantity), 0) as total_qty,
               COALESCE(SUM(total_price), 0) as total_amount
        FROM stock_movements sm
        WHERE ${whereSQL}
        GROUP BY type
    `).all(...params);

    const natureSummaryRows = db.prepare(`
        SELECT
            ${reversalExpr()} as is_reversal,
            COUNT(*) as count,
            COALESCE(SUM(sm.quantity), 0) as total_qty,
            COALESCE(SUM(sm.total_price), 0) as total_amount
        FROM stock_movements sm
        LEFT JOIN stock_documents sd ON sm.source_doc_id = sd.id
        WHERE ${whereSQL}
        GROUP BY ${reversalExpr()}
    `).all(...params);

    const natureSummary = natureSummaryRows.reduce((acc, row) => {
        const key = Number(row.is_reversal) ? 'reversal' : 'normal';
        acc[key] = {
            count: Number(row.count || 0),
            totalQty: Number(row.total_qty || 0),
            totalAmount: Number(row.total_amount || 0)
        };
        return acc;
    }, {
        normal: { count: 0, totalQty: 0, totalAmount: 0 },
        reversal: { count: 0, totalQty: 0, totalAmount: 0 }
    });

    const substitutionSummary = db.prepare(`
        SELECT
            COUNT(*) as count,
            COALESCE(SUM(sm.quantity), 0) as total_qty
        FROM stock_movements sm
        ${getSubstitutionJoinSQL('sm')}
        WHERE ${whereSQL}
          AND sdi.original_material_id IS NOT NULL
    `).get(...params);

    res.json({
        success: true,
        data: {
            items: items.map(item => ({
                ...item,
                is_reversal: Number(item.is_reversal || 0),
                reversal_of_doc_no: item.reversal_of_doc_no || null,
                original_material_id: item.original_material_id || null,
                original_material_name: item.original_material_name || null,
                original_material_code: item.original_material_code || null,
                substitution_type: item.substitution_type || null,
                substitution_reason: item.substitution_reason || null,
                has_substitution: Boolean(item.original_material_id)
            })),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            summary,
            natureSummary,
            substitutionSummary: {
                count: Number(substitutionSummary?.count || 0),
                totalQty: Number(substitutionSummary?.total_qty || 0)
            },
            productionExceptionSummary: productionExceptionStats.summary,
            productionExceptionReversalSummary: productionExceptionStats.reversalSummary,
            productionExceptionTopMaterials: productionExceptionStats.topMaterials,
            dateRange: { start, end }
        }
    });
});

router.get('/movement-documents', (req, res) => {
    const db = getDB();
    const { start, end, whereSQL, params } = buildMovementFilterContext(req.query);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const documentKeySQL = getDocumentKeySQL();

    const total = db.prepare(`
        SELECT COUNT(*) as cnt FROM (
            SELECT ${documentKeySQL} as document_no
            FROM stock_movements sm
            WHERE ${whereSQL}
            GROUP BY document_no
        )
    `).get(...params).cnt;

    const items = db.prepare(`
        SELECT
            ${documentKeySQL} as document_no,
            COALESCE(MAX(NULLIF(sm.doc_status, '')), 'posted') as document_status,
            COALESCE(MAX(NULLIF(sm.source_doc_type, '')), 'movement_execution') as document_type,
            COALESCE(MAX(NULLIF(sm.biz_type, '')), MAX(sm.source), 'manual_execution') as biz_type,
            COUNT(*) as movement_count,
            COUNT(DISTINCT sm.material_id) as material_count,
            COUNT(DISTINCT sm.warehouse_id) as warehouse_count,
            COUNT(DISTINCT sm.to_warehouse_id) as to_warehouse_count,
            COALESCE(SUM(sm.quantity), 0) as total_quantity,
            COALESCE(SUM(sm.total_price), 0) as total_amount,
            MAX(COALESCE(sm.executed_at, sm.created_at)) as executed_at,
            CASE
                WHEN COUNT(DISTINCT sm.material_id) = 1 THEN MAX(m.name)
                ELSE COUNT(DISTINCT sm.material_id) || ' 种物料'
            END as material_name,
            CASE
                WHEN COUNT(DISTINCT sm.material_id) = 1 THEN MAX(m.code)
                ELSE NULL
            END as material_code,
            CASE
                WHEN COUNT(DISTINCT sm.warehouse_id) = 1 THEN MAX(w.name)
                ELSE COUNT(DISTINCT sm.warehouse_id) || ' 个源仓'
            END as warehouse_name,
            CASE
                WHEN COUNT(DISTINCT sm.to_warehouse_id) = 1 THEN COALESCE(MAX(tw.name), '-')
                WHEN COUNT(DISTINCT sm.to_warehouse_id) > 1 THEN COUNT(DISTINCT sm.to_warehouse_id) || ' 个目标仓'
                ELSE '-'
            END as to_warehouse_name,
            CASE
                WHEN COUNT(DISTINCT sm.material_id) = 1 THEN MAX(m.unit)
                ELSE ''
            END as unit,
            MAX(sm.counterparty) as counterparty,
            MAX(sm.notes) as notes,
            CASE MAX(sm.source)
                WHEN 'manual_in' THEN '手工收货 / 回库'
                WHEN 'manual_out' THEN '手工发料 / 出库'
                WHEN 'transfer' THEN '仓间调拨'
                WHEN 'manual_adjust' THEN '盘点调整'
                ELSE COALESCE(MAX(sm.source), '-')
            END as source_label
        FROM stock_movements sm
        LEFT JOIN materials m ON sm.material_id = m.id
        LEFT JOIN warehouses w ON sm.warehouse_id = w.id
        LEFT JOIN warehouses tw ON sm.to_warehouse_id = tw.id
        WHERE ${whereSQL}
        GROUP BY document_no
        ORDER BY executed_at DESC, document_no DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    res.json({
        success: true,
        data: {
            items: items.map(item => ({
                documentNo: item.document_no,
                documentStatus: item.document_status,
                documentType: item.document_type,
                bizType: item.biz_type,
                movementCount: item.movement_count,
                materialCount: item.material_count,
                warehouseCount: item.warehouse_count,
                toWarehouseCount: item.to_warehouse_count,
                quantity: item.total_quantity,
                totalAmount: item.total_amount,
                executedAt: item.executed_at,
                materialName: item.material_name,
                materialCode: item.material_code,
                warehouseName: item.warehouse_name,
                toWarehouseName: item.to_warehouse_name,
                unit: item.unit,
                counterparty: item.counterparty,
                notes: item.notes,
                sourceLabel: item.source_label
            })),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            dateRange: { start, end }
        }
    });
});

router.get('/movement-documents/detail', (req, res) => {
    const db = getDB();
    const documentNo = String(req.query.documentNo || '').trim();

    if (!documentNo) {
        return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: '缺少 documentNo 参数' }
        });
    }

    let document = null;

    if (hasTable(db, 'stock_documents') && hasTable(db, 'stock_document_items')) {
        const header = db.prepare(`
            SELECT sd.*, w.name as warehouse_name, tw.name as to_warehouse_name
            FROM stock_documents sd
            LEFT JOIN warehouses w ON sd.warehouse_id = w.id
            LEFT JOIN warehouses tw ON sd.to_warehouse_id = tw.id
            WHERE sd.doc_no = ?
        `).get(documentNo);

        if (header) {
            const items = db.prepare(`
                SELECT sdi.*, m.name as material_name, m.code as material_code, m.unit,
                       om.name as original_material_name, om.code as original_material_code
                FROM stock_document_items sdi
                LEFT JOIN materials m ON sdi.material_id = m.id
                LEFT JOIN materials om ON sdi.original_material_id = om.id
                WHERE sdi.document_id = ?
                ORDER BY sdi.line_no ASC, sdi.id ASC
            `).all(header.id);

            const movements = db.prepare(`
                SELECT sm.*, m.name as material_name, m.code as material_code, m.unit,
                       w.name as warehouse_name, tw.name as to_warehouse_name,
                       sdi.original_material_id, sdi.substitution_type, sdi.substitution_reason,
                       om.name as original_material_name, om.code as original_material_code,
                       CASE sm.source
                           WHEN 'manual_in' THEN '手工收货 / 回库'
                           WHEN 'manual_out' THEN '手工发料 / 出库'
                           WHEN 'shipment' THEN '销售发货'
                           WHEN 'production_start' THEN '生产领料'
                           WHEN 'production_complete' THEN '生产完工入库'
                           WHEN 'production_cancel' THEN '生产退料回库'
                           WHEN 'transfer' THEN '仓间调拨'
                           WHEN 'manual_adjust' THEN '盘点调整'
                           ELSE sm.source
                       END as source_label
                FROM stock_movements sm
                LEFT JOIN materials m ON sm.material_id = m.id
                LEFT JOIN warehouses w ON sm.warehouse_id = w.id
                LEFT JOIN warehouses tw ON sm.to_warehouse_id = tw.id
                ${getSubstitutionJoinSQL('sm')}
                WHERE sm.source_doc_id = ? OR COALESCE(NULLIF(sm.source_doc_no, ''), NULLIF(sm.reference_no, ''), 'MOV-' || sm.id) = ?
                ORDER BY sm.created_at DESC, sm.id DESC
            `).all(header.id, documentNo);

            const firstItem = items[0] || {};
            const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
            const totalAmount = items.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
            const materialCount = new Set(items.map(item => item.material_id).filter(Boolean)).size;

            document = {
                documentNo: header.doc_no,
                documentStatus: header.status,
                documentType: header.doc_type,
                bizType: header.biz_type,
                sourceLabel: ({
                    manual_in: '手工收货 / 回库',
                    manual_out: '手工发料 / 出库',
                    shipment: '销售发货',
                    production_start: '生产领料',
                    production_complete: '生产完工入库',
                    production_cancel: '生产退料回库',
                    transfer: '仓间调拨',
                    manual_adjust: '盘点调整'
                })[header.source] || header.source || '-',
                movementCount: movements.length,
                movementIds: movements.map(row => row.id),
                materialCount,
                warehouseCount: header.warehouse_id ? 1 : 0,
                toWarehouseCount: header.to_warehouse_id ? 1 : 0,
                materialName: materialCount === 1 ? firstItem.material_name : `${materialCount} 种物料`,
                materialCode: materialCount === 1 ? firstItem.material_code : null,
                warehouseName: header.warehouse_name || '-',
                toWarehouseName: header.to_warehouse_name || '-',
                quantity: totalQuantity,
                unit: materialCount === 1 ? firstItem.unit : '',
                totalAmount,
                counterparty: header.counterparty || null,
                beforeQuantity: firstItem.before_quantity ?? null,
                actualQuantity: firstItem.actual_quantity ?? null,
                delta: firstItem.delta_quantity ?? totalQuantity,
                executedAt: header.executed_at || header.created_at,
                notes: header.notes || firstItem.notes || '',
                items: items.map(item => ({
                    id: item.id,
                    lineNo: item.line_no,
                    materialId: item.material_id,
                    materialName: item.material_name,
                    materialCode: item.material_code,
                    quantity: item.quantity,
                    unit: item.unit,
                    unitPrice: item.unit_price,
                    totalPrice: item.total_price,
                    beforeQuantity: item.before_quantity,
                    actualQuantity: item.actual_quantity,
                    deltaQuantity: item.delta_quantity,
                    notes: item.notes,
                    originalMaterialId: item.original_material_id || null,
                    originalMaterialName: item.original_material_name || null,
                    originalMaterialCode: item.original_material_code || null,
                    substitutionType: item.substitution_type || null,
                    substitutionReason: item.substitution_reason || null
                })),
                movements: movements.map(row => ({
                    id: row.id,
                    type: row.type,
                    quantity: row.quantity,
                    unit: row.unit,
                    warehouseName: row.warehouse_name,
                    toWarehouseName: row.to_warehouse_name || null,
                    materialName: row.material_name,
                    materialCode: row.material_code,
                    counterparty: row.counterparty,
                    referenceNo: row.reference_no,
                    sourceLabel: row.source_label || row.source || '-',
                    documentStatus: row.doc_status || 'posted',
                    executedAt: row.executed_at || row.created_at,
                    notes: row.notes,
                    unitPrice: row.unit_price,
                    totalPrice: row.total_price,
                    originalMaterialId: row.original_material_id || null,
                    originalMaterialName: row.original_material_name || null,
                    originalMaterialCode: row.original_material_code || null,
                    substitutionType: row.substitution_type || null,
                    substitutionReason: row.substitution_reason || null
                }))
            };
        }
    }

    if (!document) {
        const { whereSQL, params } = buildMovementFilterContext(req.query);
        const documentKeySQL = getDocumentKeySQL();
        const rows = db.prepare(`
            SELECT sm.*, m.name as material_name, m.code as material_code, m.unit,
                   w.name as warehouse_name, tw.name as to_warehouse_name,
                   CASE sm.source
                       WHEN 'manual_in' THEN '手工收货 / 回库'
                       WHEN 'manual_out' THEN '手工发料 / 出库'
                       WHEN 'shipment' THEN '销售发货'
                       WHEN 'production_start' THEN '生产领料'
                       WHEN 'production_complete' THEN '生产完工入库'
                       WHEN 'production_cancel' THEN '生产退料回库'
                       WHEN 'transfer' THEN '仓间调拨'
                       WHEN 'manual_adjust' THEN '盘点调整'
                       ELSE sm.source
                   END as source_label,
                   NULL as actual_quantity,
                   NULL as before_quantity
            FROM stock_movements sm
            LEFT JOIN materials m ON sm.material_id = m.id
            LEFT JOIN warehouses w ON sm.warehouse_id = w.id
            LEFT JOIN warehouses tw ON sm.to_warehouse_id = tw.id
            WHERE ${whereSQL}
              AND ${documentKeySQL} = ?
            ORDER BY sm.created_at DESC, sm.id DESC
        `).all(...params, documentNo);

        document = buildDocumentSummaryFromRows(rows);
    }

    if (!document) {
        return res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: '未找到对应轻量单据' }
        });
    }

    res.json({
        success: true,
        data: { document }
    });
});


// ============================================
// GET /api/statistics/shipment-report
// 发货统计报表
// ============================================
router.get('/shipment-report', requirePermission('reports', 'view'), (req, res) => {
    const db = getDB();
    const { start, end } = parseDateRange(req.query);
    const { status } = req.query;
    const shipmentBusinessDateSQL = getShipmentBusinessDateSQL('s');

    let whereClauses = [`date(${shipmentBusinessDateSQL}) BETWEEN ? AND ?`];
    const params = [start, end];
    if (status) { whereClauses.push('s.status = ?'); params.push(status); }
    const whereSQL = whereClauses.join(' AND ');

    // 按状态汇总
    const statusSummary = db.prepare(`
        SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total_amount
        FROM shipments s
        WHERE ${whereSQL}
        GROUP BY status
    `).all(...params);

    const natureSummaryRows = db.prepare(`
        SELECT
            CASE WHEN s.status = 'cancelled' THEN 'reversal' ELSE 'normal' END as nature,
            COUNT(*) as count,
            COALESCE(SUM(s.total_amount), 0) as total_amount
        FROM shipments s
        WHERE ${whereSQL}
        GROUP BY nature
    `).all(...params);

    const natureSummary = natureSummaryRows.reduce((acc, row) => {
        acc[row.nature] = {
            count: Number(row.count || 0),
            totalAmount: Number(row.total_amount || 0)
        };
        return acc;
    }, {
        normal: { count: 0, totalAmount: 0 },
        reversal: { count: 0, totalAmount: 0 }
    });

    // 按日汇总
    const dailySummary = db.prepare(`
        SELECT
            date(${shipmentBusinessDateSQL}) as day,
            CASE WHEN s.status = 'cancelled' THEN 'reversal' ELSE 'normal' END as nature,
            COUNT(*) as count,
            COALESCE(SUM(total_amount), 0) as total_amount
        FROM shipments s
        WHERE ${whereSQL}
        GROUP BY day, nature
        ORDER BY day
    `).all(...params);

    // 热销物料 TOP 10
    const topMaterials = db.prepare(`
        SELECT m.id, m.name, m.code, m.unit,
               SUM(si.quantity) as total_qty,
               SUM(si.total_price) as total_amount
        FROM shipment_items si
        JOIN shipments s ON si.shipment_id = s.id
        JOIN materials m ON si.material_id = m.id
        WHERE ${whereSQL} AND s.status != 'cancelled'
        GROUP BY m.id
        ORDER BY total_qty DESC
        LIMIT 10
    `).all(...params);

    const reversalTopMaterials = db.prepare(`
        SELECT m.id, m.name, m.code, m.unit,
               SUM(si.quantity) as total_qty,
               SUM(si.total_price) as total_amount
        FROM shipment_items si
        JOIN shipments s ON si.shipment_id = s.id
        JOIN materials m ON si.material_id = m.id
        WHERE ${whereSQL} AND s.status = 'cancelled'
        GROUP BY m.id
        ORDER BY total_qty DESC
        LIMIT 10
    `).all(...params);

    // 客户排行 TOP 10
    const topCustomers = db.prepare(`
        SELECT customer_name, COUNT(*) as order_count,
               COALESCE(SUM(total_amount), 0) as total_amount
        FROM shipments s
        WHERE ${whereSQL} AND s.status != 'cancelled' AND customer_name IS NOT NULL AND customer_name != ''
        GROUP BY customer_name
        ORDER BY total_amount DESC
        LIMIT 10
    `).all(...params);

    const reversalTopCustomers = db.prepare(`
        SELECT customer_name, COUNT(*) as order_count,
               COALESCE(SUM(total_amount), 0) as total_amount
        FROM shipments s
        WHERE ${whereSQL} AND s.status = 'cancelled' AND customer_name IS NOT NULL AND customer_name != ''
        GROUP BY customer_name
        ORDER BY total_amount DESC
        LIMIT 10
    `).all(...params);

    // 完整日期填充
    const dates = generateDateRange(start, end);
    const dailyMap = {};
    dailySummary.forEach(d => { dailyMap[`${d.day}_${d.nature}`] = d; });
    const dailyData = dates.map(d => ({
        day: d,
        count: dailyMap[`${d}_normal`] ? dailyMap[`${d}_normal`].count : 0,
        total_amount: dailyMap[`${d}_normal`] ? dailyMap[`${d}_normal`].total_amount : 0,
        reversal_count: dailyMap[`${d}_reversal`] ? dailyMap[`${d}_reversal`].count : 0,
        reversal_total_amount: dailyMap[`${d}_reversal`] ? dailyMap[`${d}_reversal`].total_amount : 0
    }));

    res.json({
        success: true,
        data: {
            statusSummary,
            natureSummary,
            dailyData,
            topMaterials,
            reversalTopMaterials,
            topCustomers,
            reversalTopCustomers,
            dateRange: { start, end }
        }
    });
});


// ============================================
// GET /api/statistics/category-stock
// 分类库存占比（饼图数据）
// ============================================
router.get('/category-stock', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();

    const items = db.prepare(`
        SELECT COALESCE(c.name, '未分类') as category_name,
               COUNT(DISTINCT m.id) as material_count,
               COALESCE(SUM(i.quantity), 0) as total_stock,
               COALESCE(SUM(CASE WHEN i.quantity > 0 THEN i.quantity * m.cost_price ELSE 0 END), 0) as total_value
        FROM materials m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN inventory i ON m.id = i.material_id
        WHERE m.is_active = 1
        GROUP BY c.id
        ORDER BY total_value DESC
    `).all();

    const totalValue = items.reduce((sum, item) => sum + Number(item.total_value || 0), 0);
    res.json({ success: true, data: { items, totalValue, hasValuationData: totalValue > 0 } });
});


// ============================================
// GET /api/statistics/top-materials
// 物料排行
// ============================================
router.get('/top-materials', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();
    const { start, end } = parseDateRange(req.query);
    const limit = parseInt(req.query.limit) || 10;
    const productionExceptionStats = getProductionExceptionStats(db, start, end);

    // 出库量 TOP
    const topByOutQty = db.prepare(`
        SELECT m.id, m.name, m.code, m.unit, SUM(sm.quantity) as total_qty
        FROM stock_movements sm
        JOIN materials m ON sm.material_id = m.id
        LEFT JOIN stock_documents sd ON sm.source_doc_id = sd.id
        WHERE sm.type = 'out'
          AND date(sm.created_at) BETWEEN ? AND ?
          AND ${reversalExpr()} = 0
          AND ${actionMovementFilterSQL('sm')}
        GROUP BY m.id
        ORDER BY total_qty DESC
        LIMIT ?
    `).all(start, end, limit);

    // 库存价值 TOP
    const topByValue = db.prepare(`
        SELECT m.id, m.name, m.code, m.unit,
               COALESCE(SUM(i.quantity), 0) as total_stock,
               COALESCE(SUM(CASE WHEN i.quantity > 0 THEN i.quantity * m.cost_price ELSE 0 END), 0) as total_value
        FROM materials m
        LEFT JOIN inventory i ON m.id = i.material_id
        WHERE m.is_active = 1
        GROUP BY m.id
        ORDER BY total_value DESC
        LIMIT ?
    `).all(limit);

    // 入库量 TOP
    const topByInQty = db.prepare(`
        SELECT m.id, m.name, m.code, m.unit, SUM(sm.quantity) as total_qty
        FROM stock_movements sm
        JOIN materials m ON sm.material_id = m.id
        LEFT JOIN stock_documents sd ON sm.source_doc_id = sd.id
        WHERE sm.type = 'in'
          AND date(sm.created_at) BETWEEN ? AND ?
          AND ${reversalExpr()} = 0
          AND ${actionMovementFilterSQL('sm')}
        GROUP BY m.id
        ORDER BY total_qty DESC
        LIMIT ?
    `).all(start, end, limit);

    const natureSummaryRows = db.prepare(`
        SELECT
            sm.type,
            ${reversalExpr()} as is_reversal,
            COUNT(*) as total_count,
            COALESCE(SUM(sm.quantity), 0) as total_qty,
            COALESCE(SUM(sm.total_price), 0) as total_amount
        FROM stock_movements sm
        LEFT JOIN stock_documents sd ON sm.source_doc_id = sd.id
        WHERE date(sm.created_at) BETWEEN ? AND ?
          AND sm.type IN ('in', 'out')
          AND ${actionMovementFilterSQL('sm')}
        GROUP BY sm.type, ${reversalExpr()}
    `).all(start, end);

    const natureSummary = {
        normal: { inQty: 0, outQty: 0, inCount: 0, outCount: 0, inAmount: 0, outAmount: 0 },
        reversal: { inQty: 0, outQty: 0, inCount: 0, outCount: 0, inAmount: 0, outAmount: 0 }
    };

    natureSummaryRows.forEach(row => {
        const bucket = row.is_reversal ? natureSummary.reversal : natureSummary.normal;
        if (row.type === 'in') {
            bucket.inQty = Number(row.total_qty || 0);
            bucket.inCount = Number(row.total_count || 0);
            bucket.inAmount = Number(row.total_amount || 0);
        } else if (row.type === 'out') {
            bucket.outQty = Number(row.total_qty || 0);
            bucket.outCount = Number(row.total_count || 0);
            bucket.outAmount = Number(row.total_amount || 0);
        }
    });

    res.json({
        success: true,
        data: {
            topByOutQty,
            topByValue,
            topByInQty,
            natureSummary,
            hasInventoryValueData: topByValue.some(item => Number(item.total_value || 0) > 0),
            productionExceptionTopMaterials: productionExceptionStats.topMaterials,
            productionExceptionSummary: productionExceptionStats.summary,
            productionExceptionReversalSummary: productionExceptionStats.reversalSummary,
            dateRange: { start, end }
        }
    });
});


// ============================================
// GET /api/statistics/warehouse-compare
// 仓库库存对比
// ============================================
router.get('/warehouse-compare', requirePermission('statistics', 'view'), (req, res) => {
    const db = getDB();

    const items = db.prepare(`
        SELECT w.id, w.name,
               COUNT(DISTINCT i.material_id) as material_count,
               COALESCE(SUM(i.quantity), 0) as total_stock,
               COALESCE(SUM(CASE WHEN i.quantity > 0 THEN i.quantity * m.cost_price ELSE 0 END), 0) as total_value
        FROM warehouses w
        LEFT JOIN inventory i ON w.id = i.warehouse_id AND i.quantity > 0
        LEFT JOIN materials m ON i.material_id = m.id
        WHERE w.is_active = 1
        GROUP BY w.id
        ORDER BY total_value DESC
    `).all();

    res.json({ success: true, data: { items } });
});

router.get('/inventory-consistency', requirePermission('reports', 'view'), (req, res) => {
    const db = getDB();
    res.json({ success: true, data: getInventoryConsistencySummary(db) });
});

router.get('/inventory-consistency/issues', requirePermission('reports', 'view'), (req, res) => {
    const db = getDB();
    const data = getInventoryConsistencyDetails(db, {
        issueType: req.query.issueType,
        warehouseId: req.query.warehouseId,
        search: req.query.search,
        governanceStatus: req.query.governanceStatus,
        closure: req.query.closure,
        owner: req.query.owner,
        page: req.query.page,
        limit: req.query.limit
    });
    res.json({ success: true, data });
});

router.post('/inventory-consistency/issues/governance', requirePermission('reports', 'edit'), (req, res) => {
    const db = getDB();
    const issueKey = String(req.body?.issueKey || '').trim();
    const issueType = String(req.body?.issueType || '').trim();
    const materialId = Number(req.body?.materialId || 0);
    const warehouseId = Number(req.body?.warehouseId || 0);
    const status = String(req.body?.status || 'open').trim();
    const owner = String(req.body?.owner || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const allowedStatuses = new Set(['open', 'in_progress', 'resolved', 'ignored']);

    if (!issueKey || !issueType || !materialId || !warehouseId) {
        return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: '缺少治理台账必填字段' }
        });
    }
    if (!allowedStatuses.has(status)) {
        return res.status(400).json({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: '问题状态不合法' }
        });
    }

    db.prepare(`
        INSERT INTO inventory_consistency_governance (
            issue_key, issue_type, material_id, warehouse_id, status, owner, notes, updated_by, resolved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('resolved', 'ignored') THEN datetime('now', 'localtime') ELSE NULL END, datetime('now', 'localtime'))
        ON CONFLICT(issue_key) DO UPDATE SET
            issue_type = excluded.issue_type,
            material_id = excluded.material_id,
            warehouse_id = excluded.warehouse_id,
            status = excluded.status,
            owner = excluded.owner,
            notes = excluded.notes,
            updated_by = excluded.updated_by,
            resolved_at = CASE
                WHEN excluded.status IN ('resolved', 'ignored') THEN datetime('now', 'localtime')
                ELSE NULL
            END,
            updated_at = datetime('now', 'localtime')
    `).run(
        issueKey,
        issueType,
        materialId,
        warehouseId,
        status,
        owner || null,
        notes || null,
        req.session.user.id,
        status
    );

    const row = db.prepare(`
        SELECT icg.*, u.display_name as updated_by_name
        FROM inventory_consistency_governance icg
        LEFT JOIN users u ON u.id = icg.updated_by
        WHERE icg.issue_key = ?
    `).get(issueKey);

    return res.json({
        success: true,
        data: {
            item: {
                issueKey: row.issue_key,
                governanceStatus: row.status,
                governanceStatusLabel: getInventoryConsistencyGovernanceMeta(row.status).label,
                governanceOwner: row.owner || '',
                governanceNotes: row.notes || '',
                governanceUpdatedAt: row.updated_at || null,
                governanceUpdatedByName: row.updated_by_name || null,
                isProcessed: getInventoryConsistencyGovernanceMeta(row.status).isProcessed
            }
        }
    });
});

router.get('/inventory-consistency/export', requirePermission('reports', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const data = getInventoryConsistencyDetails(db, {
        issueType: req.query.issueType,
        warehouseId: req.query.warehouseId,
        search: req.query.search,
        governanceStatus: req.query.governanceStatus,
        closure: req.query.closure,
        owner: req.query.owner,
        page: 1,
        limit: 5000
    });

    const headers = [
        { key: 'issueTypeLabel', label: '问题类型', width: 18 },
        { key: 'severityLabel', label: '风险级别', width: 12 },
        { key: 'materialCode', label: '物料编码', width: 20 },
        { key: 'materialName', label: '物料名称', width: 28 },
        { key: 'materialSpec', label: '规格', width: 22 },
        { key: 'warehouseName', label: '仓库', width: 16 },
        { key: 'inventoryQty', label: '账面库存', width: 12 },
        { key: 'movementQty', label: '流水净额', width: 12 },
        { key: 'gapQty', label: '差值', width: 12 },
        { key: 'governanceStatusLabel', label: '治理状态', width: 12 },
        { key: 'governanceOwner', label: '责任人', width: 16 },
        { key: 'governanceNotes', label: '处理备注', width: 30 },
        { key: 'reason', label: '治理提示', width: 60 }
    ];
    const rows = data.items.map(item => ({
        issueTypeLabel: item.issueTypeLabel,
        severityLabel: item.severityLabel,
        materialCode: item.materialCode,
        materialName: item.materialName,
        materialSpec: item.materialSpec,
        warehouseName: item.warehouseName,
        inventoryQty: item.inventoryQty,
        movementQty: item.movementQty,
        gapQty: item.gapQty,
        governanceStatusLabel: item.governanceStatusLabel,
        governanceOwner: item.governanceOwner,
        governanceNotes: item.governanceNotes,
        reason: item.reason
    }));
    const today = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
        setDownloadHeaders(res, `库存一致性问题明细_${today}.json`, 'application/json; charset=utf-8');
        return res.send(JSON.stringify(rows, null, 2));
    }
    if (format === 'csv') {
        setDownloadHeaders(res, `库存一致性问题明细_${today}.csv`, 'text/csv; charset=utf-8');
        return res.send(toCSV(headers, rows));
    }

    setDownloadHeaders(res, `库存一致性问题明细_${today}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = await toExcel('库存一致性问题', headers, rows);
    const buffer = await workbook.xlsx.writeBuffer();
    return res.send(Buffer.from(buffer));
}));


module.exports = router;
