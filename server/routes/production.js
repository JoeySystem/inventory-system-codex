/**
 * 生产工单路由
 * GET    /api/production              - 工单列表
 * GET    /api/production/:id          - 工单详情
 * POST   /api/production              - 创建工单（自动计算物料需求）
 * PUT    /api/production/:id/status   - 更新状态（开始/完成/取消）
 * PUT    /api/production/:id/progress - 更新完成数量
 * GET    /api/production/:id/check    - 物料齐套检查
 */

const express = require('express');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { logOperation } = require('../utils/logger');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const {
    createDocument,
    submitDocument,
    executeDocument,
    postDocument,
    reverseDocument,
    getDocumentById,
    listDocumentsByOrigin
} = require('../services/stockDocuments');
const { getAvailable } = require('../services/inventory');

const router = express.Router();
router.use(requireAuth);

/**
 * 生成工单号 PO-YYYYMMDD-NNN
 */
function generateOrderNo(db) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const last = db.prepare(
        "SELECT order_no FROM production_orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1"
    ).get(`PO-${today}-%`);

    let seq = 1;
    if (last) {
        const parts = last.order_no.split('-');
        seq = parseInt(parts[2]) + 1;
    }
    return `PO-${today}-${String(seq).padStart(3, '0')}`;
}

function generateProductionExceptionNo(db) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const last = db.prepare(
        "SELECT exception_no FROM production_exceptions WHERE exception_no LIKE ? ORDER BY exception_no DESC LIMIT 1"
    ).get(`PEX-${today}-%`);

    let seq = 1;
    if (last?.exception_no) {
        const parts = last.exception_no.split('-');
        seq = parseInt(parts[2], 10) + 1;
    }
    return `PEX-${today}-${String(seq).padStart(3, '0')}`;
}

function safeParseJSON(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function summarizeSupplyModes(items = []) {
    const summary = {
        purchase_only: 0,
        direct_issue: 0,
        prebuild_wip: 0,
        on_site_fabrication: 0
    };
    items.forEach(item => {
        const key = item.supplyMode;
        if (Object.prototype.hasOwnProperty.call(summary, key)) {
            summary[key] += 1;
        }
    });
    return summary;
}

function getSupplyModeMeta(mode) {
    const map = {
        purchase_only: { label: '采购入库后领用', hint: '先采购收货入库，再按工单直接领用。', warehouseAction: '仓库先做收货入库，再按工单发料。' },
        direct_issue: { label: '库存现成件直接领用', hint: '现成库存件可直接发料到当前工单。', warehouseAction: '仓库按工单直接发料。' },
        prebuild_wip: { label: '先做半成品再领用', hint: '应先通过前置工单完工入库，再在当前工单领用。', warehouseAction: '仓库等待前置半成品完工入库后，再执行发料。' },
        on_site_fabrication: { label: '当前工单现场加工', hint: '仓库发出原材，车间在当前工单中现场裁剪、焊接或装配。', warehouseAction: '仓库发出原材料，车间现场加工，剩余部分按退料回库。' }
    };
    return map[mode] || map.direct_issue;
}

function getOrderSubstitutionPlan(order) {
    const items = safeParseJSON(order.substitution_plan_json, []);
    if (!Array.isArray(items)) return [];
    return items;
}

function getSubstitutionCandidates(db, materialId, warehouseId) {
    return db.prepare(`
        SELECT ms.*, m.name as substitute_material_name, m.code as substitute_material_code,
               m.unit as substitute_unit, m.spec as substitute_spec, m.lifecycle_status,
               COALESCE((SELECT SUM(i.quantity) FROM inventory i WHERE i.material_id = m.id AND i.warehouse_id = ?), 0) as available_stock
        FROM material_substitutions ms
        JOIN materials m ON m.id = ms.substitute_material_id
        WHERE ms.material_id = ?
          AND COALESCE(ms.is_active, 1) = 1
          AND m.is_active = 1
          AND m.lifecycle_status = 'active'
        ORDER BY ms.priority ASC, ms.id ASC
    `).all(warehouseId, materialId).map(row => ({
        id: row.id,
        substituteMaterialId: row.substitute_material_id,
        substituteMaterialName: row.substitute_material_name,
        substituteMaterialCode: row.substitute_material_code,
        substituteUnit: row.substitute_unit,
        substituteSpec: row.substitute_spec || null,
        priority: Number(row.priority || 1),
        substitutionType: row.substitution_type || 'full',
        reason: row.reason || null,
        availableStock: Number(row.available_stock || 0)
    }));
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

    const currentStock = Number(getAvailable(db, materialId, warehouseId) || 0);
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
    let score = 0;

    if (singleSource) { score += 40; reasons.push('唯一供应商'); }
    if (effectiveLeadTimeDays >= 30) { score += 40; reasons.push(`交期 ${effectiveLeadTimeDays} 天`); }
    else if (effectiveLeadTimeDays >= 14) { score += 30; reasons.push(`交期 ${effectiveLeadTimeDays} 天`); }
    else if (effectiveLeadTimeDays >= 7) { score += 20; reasons.push(`交期 ${effectiveLeadTimeDays} 天`); }
    if (!hasSubstitution) { score += 25; reasons.push('无替代料'); }
    if (Number(material.is_key_part || 0) === 1) { score += 25; reasons.push('关键件'); }
    if (warningThreshold > 0 && currentStock <= warningThreshold) { score += 20; reasons.push('低于安全阈值'); }
    if (reorderPoint > 0 && currentStock <= reorderPoint) { score += 15; reasons.push('低于补货点'); }
    if (coverageDays !== null && effectiveLeadTimeDays > 0 && coverageDays < (effectiveLeadTimeDays + safetyBufferDays)) {
        score += 25;
        reasons.push(`库存仅够 ${coverageDays.toFixed(1)} 天，低于交期+缓冲 ${effectiveLeadTimeDays + safetyBufferDays} 天`);
    }
    if (coverageDays !== null && coverageDaysTarget > 0 && coverageDays < coverageDaysTarget) {
        score += 15;
        reasons.push(`库存仅够 ${coverageDays.toFixed(1)} 天，低于目标保供天数 ${coverageDaysTarget} 天`);
    }

    const result = {
        materialId: Number(material.id),
        materialName: material.name,
        materialCode: material.code,
        riskScore: score,
        riskLevel: getSupplyRiskLevel(score),
        reasons,
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
        riskNotes: material.supply_risk_notes || null
    };
    if (result.riskLevel === 'critical' || (coverageDays !== null && effectiveLeadTimeDays > 0 && coverageDays < (effectiveLeadTimeDays + safetyBufferDays))) {
        result.procurementAdvice = {
            urgency: 'urgent',
            actionLabel: '采购任务',
            primaryAction: '建议立即生成采购任务并锁定交期',
            buyerHint: '优先联系供应商确认可交期、可供数量和替代渠道'
        };
    } else if (result.riskLevel === 'high' || singleSource || effectiveLeadTimeDays >= 7) {
        result.procurementAdvice = {
            urgency: 'high',
            actionLabel: '采购跟进',
            primaryAction: '建议生成采购跟进任务',
            buyerHint: '尽快核对库存覆盖、交期缓冲和备料计划'
        };
    } else {
        result.procurementAdvice = {
            urgency: 'normal',
            actionLabel: '持续观察',
            primaryAction: '持续观察供应风险变化',
            buyerHint: '保持例行跟踪'
        };
    }
    return result;
}

function buildOrderSubstitutionMap(order) {
    return new Map(
        getOrderSubstitutionPlan(order)
            .filter(item => item && item.originalMaterialId)
            .map(item => [Number(item.originalMaterialId), item])
    );
}

function resolveBomForProduction(db, outputMaterialId) {
    if (!outputMaterialId) return null;

    const material = db.prepare(`
        SELECT id, default_bom_id
        FROM materials
        WHERE id = ?
    `).get(outputMaterialId);

    if (material?.default_bom_id) {
        const bom = db.prepare(`
            SELECT *
            FROM boms
            WHERE id = ? AND is_active = 1
        `).get(material.default_bom_id);
        if (bom) return bom;
    }

    return db.prepare(`
        SELECT *
        FROM boms
        WHERE output_material_id = ? AND is_active = 1
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
    `).get(outputMaterialId);
}

function buildProductionSnapshots(db, { sopId, warehouseId, plannedQuantity, outputMaterialId, notes }) {
    const sop = db.prepare(`
        SELECT *
        FROM sops
        WHERE id = ?
    `).get(sopId);
    if (!sop) throw new NotFoundError('SOP');

    const steps = db.prepare(`
        SELECT *
        FROM sop_steps
        WHERE sop_id = ?
        ORDER BY step_number
    `).all(sopId);

    const materials = db.prepare(`
        SELECT sm.*, m.name as material_name, m.code as material_code, m.unit, m.spec,
               m.material_type, m.supply_mode,
               st.step_number, st.title as step_title
        FROM sop_materials sm
        JOIN materials m ON sm.material_id = m.id
        LEFT JOIN sop_steps st ON sm.step_id = st.id
        WHERE sm.sop_id = ?
        ORDER BY COALESCE(st.step_number, 9999), m.name
    `).all(sopId);

    const bom = resolveBomForProduction(db, outputMaterialId || null);
    const bomItems = bom ? db.prepare(`
        SELECT bi.*, m.name as material_name, m.code as material_code, m.unit, m.spec, m.material_type, m.supply_mode,
               sb.name as sub_bom_name, sb.code as sub_bom_code
        FROM bom_items bi
        LEFT JOIN materials m ON bi.material_id = m.id
        LEFT JOIN boms sb ON bi.sub_bom_id = sb.id
        WHERE bi.bom_id = ?
        ORDER BY bi.sort_order, bi.id
    `).all(bom.id) : [];

    const snapshotCreatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    return {
        snapshotCreatedAt,
        sopSnapshot: {
            sourceSopId: sop.id,
            title: sop.title,
            version: sop.version,
            category: sop.category || null,
            description: sop.description || null,
            steps: steps.map(step => ({
                stepNumber: step.step_number,
                title: step.title,
                description: step.description || null,
                durationMinutes: step.duration_minutes || null,
                notes: step.notes || null
            })),
            materials: materials.map(item => ({
                materialId: item.material_id,
                materialName: item.material_name,
                materialCode: item.material_code,
                unit: item.unit,
                spec: item.spec || null,
                materialType: item.material_type || null,
                supplyMode: item.supply_mode || 'direct_issue',
                supplyModeLabel: getSupplyModeMeta(item.supply_mode).label,
                supplyModeHint: getSupplyModeMeta(item.supply_mode).hint,
                warehouseAction: getSupplyModeMeta(item.supply_mode).warehouseAction,
                allowSubstitution: Boolean(item.allow_substitution),
                substitutionPriority: Number(item.substitution_priority || 1),
                quantityPerUnit: Number(item.quantity_per_unit || 0),
                stepNumber: item.step_number || null,
                stepTitle: item.step_title || null,
                notes: item.notes || null
            }))
        },
        bomSnapshot: bom ? {
            sourceBomId: bom.id,
            code: bom.code,
            name: bom.name,
            version: bom.version,
            outputMaterialId: bom.output_material_id,
            outputQuantity: Number(bom.output_quantity || 0),
            category: bom.category || null,
            description: bom.description || null,
            items: bomItems.map(item => ({
                lineId: item.id,
                materialId: item.material_id || null,
                materialName: item.material_name || null,
                materialCode: item.material_code || null,
                unit: item.unit || null,
                spec: item.spec || null,
                materialType: item.material_type || null,
                supplyMode: item.supply_mode || 'direct_issue',
                supplyModeLabel: getSupplyModeMeta(item.supply_mode).label,
                supplyModeHint: getSupplyModeMeta(item.supply_mode).hint,
                allowSubstitution: Boolean(item.allow_substitution),
                substitutionPriority: Number(item.substitution_priority || 1),
                subBomId: item.sub_bom_id || null,
                subBomName: item.sub_bom_name || null,
                subBomCode: item.sub_bom_code || null,
                quantity: Number(item.quantity || 0),
                lossRate: Number(item.loss_rate || 0),
                position: item.position || null,
                notes: item.notes || null
            }))
        } : null,
        workorderSnapshot: {
            plannedQuantity: Number(plannedQuantity),
            warehouseId: Number(warehouseId),
            outputMaterialId: outputMaterialId ? Number(outputMaterialId) : null,
            notes: notes || null,
            supplyModeSummary: summarizeSupplyModes(materials.map(item => ({
                supplyMode: item.supply_mode || 'direct_issue'
            }))),
            supplyModeGuide: Object.entries(summarizeSupplyModes(materials.map(item => ({
                supplyMode: item.supply_mode || 'direct_issue'
            })))).filter(([, count]) => count > 0).map(([mode, count]) => ({
                mode,
                count,
                ...getSupplyModeMeta(mode)
            }))
        }
    };
}

function getOrderSnapshots(order) {
    return {
        createdAt: order.snapshot_created_at || order.created_at || null,
        sop: safeParseJSON(order.sop_snapshot_json, null),
        bom: safeParseJSON(order.bom_snapshot_json, null),
        workorder: safeParseJSON(order.workorder_snapshot_json, null)
    };
}

function getOrderStepSnapshot(order) {
    return (getOrderSnapshots(order).sop?.steps || []).map(step => ({
        step_number: step.stepNumber,
        title: step.title,
        description: step.description || null,
        duration_minutes: step.durationMinutes || null,
        notes: step.notes || null
    }));
}

function getOrderMaterialRequirements(db, order, quantity = order.planned_quantity) {
    const snapshots = getOrderSnapshots(order);
    const sopMaterials = snapshots.sop?.materials || [];
    const substitutionPlanMap = buildOrderSubstitutionMap(order);

    function enrichRequirement(baseItem) {
        const allowSubstitution = Boolean(baseItem.allowSubstitution || baseItem.allow_substitution);
        const substitutionPriority = Number(baseItem.substitutionPriority || baseItem.substitution_priority || 1);
        const totalNeeded = Number(baseItem.quantityPerUnit || baseItem.quantity_per_unit || 0) * Number(quantity || 0);
        const availableStock = getAvailable(db, baseItem.materialId || baseItem.material_id, order.warehouse_id);
        const suggestions = allowSubstitution
            ? getSubstitutionCandidates(db, baseItem.materialId || baseItem.material_id, order.warehouse_id)
            : [];
        const selectedPlan = substitutionPlanMap.get(Number(baseItem.materialId || baseItem.material_id)) || null;
        const selectedSuggestion = selectedPlan
            ? suggestions.find(item => Number(item.substituteMaterialId) === Number(selectedPlan.substituteMaterialId)) || null
            : null;
        const effectiveAvailable = selectedSuggestion ? Number(selectedSuggestion.availableStock || 0) : availableStock;

        return {
            material_id: baseItem.materialId || baseItem.material_id,
            name: baseItem.materialName || baseItem.name,
            code: baseItem.materialCode || baseItem.code,
            unit: baseItem.unit,
            spec: baseItem.spec || null,
            material_type: baseItem.materialType || baseItem.material_type || null,
            supply_mode: baseItem.supplyMode || baseItem.supply_mode || 'direct_issue',
            supply_mode_label: baseItem.supplyModeLabel || baseItem.supply_mode_label || getSupplyModeMeta(baseItem.supplyMode || baseItem.supply_mode).label,
            supply_mode_hint: baseItem.supplyModeHint || baseItem.supply_mode_hint || getSupplyModeMeta(baseItem.supplyMode || baseItem.supply_mode).hint,
            warehouse_action: baseItem.warehouseAction || baseItem.warehouse_action || getSupplyModeMeta(baseItem.supplyMode || baseItem.supply_mode).warehouseAction,
            quantity_per_unit: Number(baseItem.quantityPerUnit || baseItem.quantity_per_unit || 0),
            total_needed: totalNeeded,
            available_stock: availableStock,
            available: availableStock,
            effective_available_stock: effectiveAvailable,
            step_number: baseItem.stepNumber || baseItem.step_number || null,
            step_title: baseItem.stepTitle || baseItem.step_title || null,
            allow_substitution: allowSubstitution,
            substitution_priority: substitutionPriority,
            substitution_candidates: suggestions,
            selected_substitution: selectedPlan ? {
                ...selectedPlan,
                availableStock: selectedSuggestion ? Number(selectedSuggestion.availableStock || 0) : 0
            } : null,
            supply_risk: getMaterialSupplyRiskContext(db, baseItem.materialId || baseItem.material_id, order.warehouse_id),
            selected_substitution_risk: selectedPlan?.substituteMaterialId
                ? getMaterialSupplyRiskContext(db, selectedPlan.substituteMaterialId, order.warehouse_id)
                : null
        };
    }

    if (sopMaterials.length) {
        return sopMaterials.map(enrichRequirement);
    }

    return db.prepare(`
        SELECT sm.material_id, m.name, m.code, m.unit, m.spec, m.material_type, m.supply_mode,
               sm.allow_substitution, sm.substitution_priority,
               sm.quantity_per_unit,
               sm.quantity_per_unit * ? as total_needed,
               COALESCE((SELECT SUM(i.quantity) FROM inventory i WHERE i.material_id = sm.material_id AND i.warehouse_id = ?), 0) as available_stock,
               st.step_number, st.title as step_title
        FROM sop_materials sm
        JOIN materials m ON sm.material_id = m.id
        LEFT JOIN sop_steps st ON sm.step_id = st.id
        WHERE sm.sop_id = ?
        ORDER BY COALESCE(st.step_number, 9999), m.name
    `).all(quantity, order.warehouse_id, order.sop_id).map(enrichRequirement);
}

function getOrderReturnedQuantity(order) {
    return Number(order.returned_quantity || 0);
}

function getOrderRemainingQuantity(order) {
    return Math.max(
        0,
        Number(order.planned_quantity || 0) - Number(order.completed_quantity || 0) - getOrderReturnedQuantity(order)
    );
}

function closeOrderStatusForRemaining(order, nextCompletedQuantity, nextReturnedQuantity) {
    const planned = Number(order.planned_quantity || 0);
    if (Number(nextCompletedQuantity || 0) + Number(nextReturnedQuantity || 0) < planned) return order.status;
    return Number(nextCompletedQuantity || 0) > 0 ? 'completed' : 'cancelled';
}

function buildProductionIssueDocumentPayload(order, materials) {
    return {
        docType: 'production_issue_execution',
        warehouseId: order.warehouse_id,
        counterparty: order.order_no,
        originType: 'production_order',
        originId: order.id,
        notes: `生产领料: ${order.order_no}`,
        items: materials.map(m => ({
            materialId: m.selected_substitution?.substituteMaterialId || m.material_id,
            originalMaterialId: m.selected_substitution?.substituteMaterialId ? m.material_id : null,
            substitutionType: m.selected_substitution?.substitutionType || null,
            substitutionReason: m.selected_substitution?.reason || null,
            quantity: Number(m.total_needed),
            notes: m.selected_substitution?.substituteMaterialId
                ? `生产领料替代: ${order.order_no} / 原料 ${m.name} -> 替代 ${m.selected_substitution.substituteMaterialName}${m.selected_substitution.reason ? ` / 原因: ${m.selected_substitution.reason}` : ''}`
                : `生产领料: ${order.order_no}`
        }))
    };
}

function buildProductionReceiptDocumentPayload(order, completedQty) {
    return {
        docType: 'production_receive_execution',
        warehouseId: order.warehouse_id,
        counterparty: order.order_no,
        originType: 'production_order',
        originId: order.id,
        notes: `生产完工入库: ${order.order_no}（本次 ${Number(completedQty)}）`,
        items: [{
            materialId: order.output_material_id,
            quantity: Number(completedQty),
            notes: `生产完工入库: ${order.order_no}`
        }]
    };
}

function buildProductionReturnDocumentPayload(order, materials, returnQty) {
    return {
        docType: 'production_return_execution',
        warehouseId: order.warehouse_id,
        counterparty: order.order_no,
        originType: 'production_order',
        originId: order.id,
        notes: `生产退料回库: ${order.order_no}（本次 ${Number(returnQty || 0)}）`,
        items: materials.map(m => ({
            materialId: m.material_id,
            quantity: Number(m.total_needed),
            notes: `生产退料回库: ${order.order_no}`
        }))
    };
}

function fetchProductionMaterials(db, order, quantity = order.planned_quantity) {
    return getOrderMaterialRequirements(db, order, quantity).map(item => ({
        material_id: item.material_id,
        name: item.name,
        unit: item.unit,
        spec: item.spec,
        quantity_per_unit: item.quantity_per_unit,
        total_needed: item.total_needed,
        available: item.available,
        effective_available_stock: item.effective_available_stock,
        selected_substitution: item.selected_substitution || null,
        allow_substitution: item.allow_substitution
    }));
}

function hydrateProductionDocument(db, documentId) {
    return documentId ? getDocumentById(db, documentId) : null;
}

function listProductionDocuments(db, orderId, docType) {
    return listDocumentsByOrigin(db, 'production_order', Number(orderId), docType);
}

function listProductionExceptions(db, orderId) {
    return db.prepare(`
        SELECT pe.*, m.name as material_name, m.code as material_code, m.unit,
               origin.exception_no as reversal_of_exception_no,
               child.exception_no as reversed_by_exception_no
        FROM production_exceptions pe
        LEFT JOIN materials m ON pe.material_id = m.id
        LEFT JOIN production_exceptions origin ON pe.reversal_of_exception_id = origin.id
        LEFT JOIN production_exceptions child ON pe.reversed_by_exception_id = child.id
        WHERE pe.order_id = ?
        ORDER BY pe.created_at DESC, pe.id DESC
    `).all(orderId).map(row => ({
        id: row.id,
        exceptionNo: row.exception_no,
        exceptionType: row.exception_type,
        direction: row.direction,
        materialId: row.material_id,
        materialName: row.material_name,
        materialCode: row.material_code,
        unit: row.unit,
        quantity: Number(row.quantity || 0),
        status: row.status || 'posted',
        isReversal: Boolean(row.is_reversal),
        reversalOfExceptionId: row.reversal_of_exception_id || null,
        reversalOfExceptionNo: row.reversal_of_exception_no || null,
        reversedByExceptionId: row.reversed_by_exception_id || null,
        reversedByExceptionNo: row.reversed_by_exception_no || null,
        reversedAt: row.reversed_at || null,
        reversalReason: row.reversal_reason || null,
        notes: row.notes || null,
        createdAt: row.created_at,
        stockDocumentId: row.stock_document_id || null,
        document: row.stock_document_id ? getDocumentById(db, row.stock_document_id) : null
    }));
}

function getProductionExceptionById(db, orderId, exceptionId) {
    const row = db.prepare(`
        SELECT pe.*, m.name as material_name, m.code as material_code, m.unit,
               origin.exception_no as reversal_of_exception_no,
               child.exception_no as reversed_by_exception_no
        FROM production_exceptions pe
        LEFT JOIN materials m ON pe.material_id = m.id
        LEFT JOIN production_exceptions origin ON pe.reversal_of_exception_id = origin.id
        LEFT JOIN production_exceptions child ON pe.reversed_by_exception_id = child.id
        WHERE pe.id = ? AND pe.order_id = ?
    `).get(exceptionId, orderId);

    if (!row) throw new NotFoundError('工单异常单');
    return {
        id: row.id,
        exceptionNo: row.exception_no,
        exceptionType: row.exception_type,
        direction: row.direction,
        materialId: row.material_id,
        materialName: row.material_name,
        materialCode: row.material_code,
        unit: row.unit,
        quantity: Number(row.quantity || 0),
        status: row.status || 'posted',
        isReversal: Boolean(row.is_reversal),
        reversalOfExceptionId: row.reversal_of_exception_id || null,
        reversalOfExceptionNo: row.reversal_of_exception_no || null,
        reversedByExceptionId: row.reversed_by_exception_id || null,
        reversedByExceptionNo: row.reversed_by_exception_no || null,
        reversedAt: row.reversed_at || null,
        reversalReason: row.reversal_reason || null,
        notes: row.notes || null,
        createdAt: row.created_at,
        stockDocumentId: row.stock_document_id || null,
        document: row.stock_document_id ? getDocumentById(db, row.stock_document_id) : null
    };
}

function buildProductionExceptionDocumentPayload(order, exceptionType, direction, materialId, quantity, notes) {
    let docType;
    if (exceptionType === 'scrap') {
        docType = 'production_scrap_issue_execution';
    } else if (exceptionType === 'supplement') {
        docType = 'production_supplement_issue_execution';
    } else if (exceptionType === 'over_issue') {
        docType = 'production_over_issue_execution';
    } else if (exceptionType === 'variance') {
        docType = direction === 'in'
            ? 'production_variance_receive_execution'
            : 'production_variance_issue_execution';
    } else {
        throw new ValidationError('不支持的异常类型');
    }

    return {
        docType,
        warehouseId: order.warehouse_id,
        counterparty: order.order_no,
        originType: 'production_exception',
        notes: `工单异常: ${order.order_no} / ${exceptionType}`,
        items: [{
            materialId,
            quantity: Number(quantity),
            notes: notes || `工单异常: ${order.order_no}`
        }]
    };
}

/**
 * GET /api/production
 */
router.get('/', requirePermission('production', 'view'), (req, res) => {
    const db = getDB();
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClauses = ['1=1'];
    let params = [];

    if (status) { whereClauses.push('po.status = ?'); params.push(status); }

    const whereSQL = whereClauses.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM production_orders po WHERE ${whereSQL}`).get(...params).cnt;

    const orders = db.prepare(`
        SELECT po.*, s.title as sop_title, s.version as sop_version,
               w.name as warehouse_name, u.display_name as creator_name,
               om.name as output_material_name, om.unit as output_unit,
               issue_doc.doc_no as issue_document_no, issue_doc.status as issue_document_status,
               receipt_doc.doc_no as receipt_document_no, receipt_doc.status as receipt_document_status,
               return_doc.doc_no as return_document_no, return_doc.status as return_document_status
        FROM production_orders po
        LEFT JOIN sops s ON po.sop_id = s.id
        LEFT JOIN warehouses w ON po.warehouse_id = w.id
        LEFT JOIN users u ON po.created_by = u.id
        LEFT JOIN materials om ON po.output_material_id = om.id
        LEFT JOIN stock_documents issue_doc ON po.issue_document_id = issue_doc.id
        LEFT JOIN stock_documents receipt_doc ON po.receipt_document_id = receipt_doc.id
        LEFT JOIN stock_documents return_doc ON po.return_document_id = return_doc.id
        WHERE ${whereSQL}
        ORDER BY po.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    const mappedOrders = orders.map(order => {
        const snapshots = getOrderSnapshots(order);
        return {
            ...order,
            returned_quantity: Number(order.returned_quantity || 0),
            remaining_quantity: getOrderRemainingQuantity(order),
            sop_title: order.sop_title || snapshots.sop?.title || null,
            sop_version: order.sop_version || snapshots.sop?.version || null,
            snapshot_created_at: snapshots.createdAt,
            sop_snapshot_title: snapshots.sop?.title || null,
            sop_snapshot_version: snapshots.sop?.version || null,
            bom_snapshot_name: snapshots.bom?.name || null,
            bom_snapshot_version: snapshots.bom?.version || null
        };
    });

    res.json({
        success: true,
        data: {
            orders: mappedOrders,
            pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
        }
    });
});

/**
 * GET /api/production/:id
 */
router.get('/:id', requirePermission('production', 'view'), (req, res) => {
    const db = getDB();
    let order = db.prepare(`
        SELECT po.*, s.title as sop_title, s.version as sop_version, s.description as sop_description,
               w.name as warehouse_name, u.display_name as creator_name,
               om.name as output_material_name, om.unit as output_unit, om.code as output_material_code,
               issue_doc.doc_no as issue_document_no, issue_doc.status as issue_document_status,
               receipt_doc.doc_no as receipt_document_no, receipt_doc.status as receipt_document_status,
               return_doc.doc_no as return_document_no, return_doc.status as return_document_status
        FROM production_orders po
        LEFT JOIN sops s ON po.sop_id = s.id
        LEFT JOIN warehouses w ON po.warehouse_id = w.id
        LEFT JOIN users u ON po.created_by = u.id
        LEFT JOIN materials om ON po.output_material_id = om.id
        LEFT JOIN stock_documents issue_doc ON po.issue_document_id = issue_doc.id
        LEFT JOIN stock_documents receipt_doc ON po.receipt_document_id = receipt_doc.id
        LEFT JOIN stock_documents return_doc ON po.return_document_id = return_doc.id
        WHERE po.id = ?
    `).get(req.params.id);

    if (!order) throw new NotFoundError('生产工单');

    const snapshots = getOrderSnapshots(order);
    order = {
        ...order,
        returned_quantity: Number(order.returned_quantity || 0),
        sop_title: order.sop_title || snapshots.sop?.title || null,
        sop_version: order.sop_version || snapshots.sop?.version || null,
        sop_description: order.sop_description || snapshots.sop?.description || null
    };

    // SOP 步骤
    const steps = getOrderStepSnapshot(order);

    const materials = getOrderMaterialRequirements(db, order, order.planned_quantity);

    // 标记不足
    materials.forEach(m => {
        const effectiveAvailable = m.selected_substitution ? Number(m.selected_substitution.availableStock || 0) : Number(m.available_stock || 0);
        m.is_sufficient = effectiveAvailable >= m.total_needed;
        m.shortage = m.is_sufficient ? 0 : m.total_needed - effectiveAvailable;
        m.shortage_basis = m.selected_substitution ? 'selected_substitution' : 'original_material';
    });

    materials.sort((a, b) => {
        const aInsufficient = a.is_sufficient ? 1 : 0;
        const bInsufficient = b.is_sufficient ? 1 : 0;
        return (aInsufficient - bInsufficient)
            || ((b.supply_risk?.riskScore || 0) - (a.supply_risk?.riskScore || 0))
            || ((b.shortage || 0) - (a.shortage || 0))
            || String(a.code || '').localeCompare(String(b.code || ''), 'zh-Hans-CN');
    });

    const allSufficient = materials.every(m => m.is_sufficient);
    const highRiskMaterials = materials
        .filter(m => ['critical', 'high'].includes(m.supply_risk?.riskLevel))
        .sort((a, b) => (b.supply_risk?.riskScore || 0) - (a.supply_risk?.riskScore || 0));

    res.json({
        success: true,
        data: {
            order,
            steps,
            materials,
            allSufficient,
            hasHighRiskMaterials: highRiskMaterials.length > 0,
            highRiskMaterials,
            snapshots,
            bomItems: snapshots.bom?.items || [],
            substitutionPlan: getOrderSubstitutionPlan(order),
            substitutionExecuted: safeParseJSON(order.substitution_executed_json, []),
            remainingQuantity: getOrderRemainingQuantity(order),
            exceptions: listProductionExceptions(db, order.id),
            documents: {
                issue: hydrateProductionDocument(db, order.issue_document_id),
                receipt: hydrateProductionDocument(db, order.receipt_document_id),
                return: hydrateProductionDocument(db, order.return_document_id),
                receipts: listProductionDocuments(db, order.id, 'production_receive_execution'),
                returns: listProductionDocuments(db, order.id, 'production_return_execution')
            }
        }
    });
});

/**
 * GET /api/production/:id/check
 * 物料齐套检查
 */
router.get('/:id/check', requirePermission('production', 'view'), (req, res) => {
    const db = getDB();
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');

    const materials = getOrderMaterialRequirements(db, order, order.planned_quantity);

    const insufficient = materials.filter(m => m.available_stock < m.total_needed).map(m => ({
        ...m,
        shortage: m.total_needed - m.available_stock
    })).sort((a, b) =>
        ((b.supply_risk?.riskScore || 0) - (a.supply_risk?.riskScore || 0))
        || ((b.shortage || 0) - (a.shortage || 0))
        || String(a.code || '').localeCompare(String(b.code || ''), 'zh-Hans-CN')
    );

    res.json({
        success: true,
        data: {
            allSufficient: insufficient.length === 0,
            total: materials.length,
            insufficientCount: insufficient.length,
            insufficient
        }
    });
});

router.put('/:id/substitutions', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');
    if (order.status !== 'planned') throw new ConflictError('只有计划中工单允许维护替代料方案');

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const requirements = getOrderMaterialRequirements(db, order, order.planned_quantity);
    const requirementMap = new Map(requirements.map(item => [Number(item.material_id), item]));

    const normalized = items.filter(item => item && item.originalMaterialId && item.substituteMaterialId).map(item => {
        const originalMaterialId = Number(item.originalMaterialId);
        const substituteMaterialId = Number(item.substituteMaterialId);
        const reason = String(item.reason || '').trim();
        const requirement = requirementMap.get(originalMaterialId);
        if (!requirement) throw new ValidationError('存在不属于当前工单的原始物料', 'items');
        if (!requirement.allow_substitution) throw new ValidationError(`物料 ${requirement.name} 当前不允许替代`, 'items');
        const candidate = (requirement.substitution_candidates || []).find(row => Number(row.substituteMaterialId) === substituteMaterialId);
        if (!candidate) throw new ValidationError(`物料 ${requirement.name} 选择的替代料无效`, 'items');
        return {
            originalMaterialId,
            originalMaterialName: requirement.name,
            originalMaterialCode: requirement.code,
            substituteMaterialId,
            substituteMaterialName: candidate.substituteMaterialName,
            substituteMaterialCode: candidate.substituteMaterialCode,
            substitutionType: candidate.substitutionType || 'full',
            reason: reason || candidate.reason || null,
            priority: Number(candidate.priority || 1),
            selectedAt: new Date().toISOString(),
            selectedBy: req.session.user.id
        };
    });

    db.prepare(`
        UPDATE production_orders
        SET substitution_plan_json = ?,
            workorder_snapshot_json = ?
        WHERE id = ?
    `).run(
        normalized.length ? JSON.stringify(normalized) : null,
        JSON.stringify({
            ...(safeParseJSON(order.workorder_snapshot_json, {}) || {}),
            substitutionPlan: normalized
        }),
        order.id
    );

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'production',
        resourceId: order.id,
        detail: normalized.length ? `维护工单替代方案: ${order.order_no}，共 ${normalized.length} 条` : `清空工单替代方案: ${order.order_no}`,
        ip: req.ip
    });

    res.json({ success: true, data: { items: normalized } });
});

/**
 * POST /api/production
 * 创建生产工单
 */
router.post('/', requirePermission('production', 'add'), (req, res) => {
    const db = getDB();
    const { sopId, warehouseId, plannedQuantity, outputMaterialId, notes } = req.body;

    if (!sopId) throw new ValidationError('请选择SOP');
    if (!warehouseId) throw new ValidationError('请选择仓库');
    if (!plannedQuantity || plannedQuantity <= 0) throw new ValidationError('计划数量必须大于0');

    const sop = db.prepare('SELECT * FROM sops WHERE id = ? AND is_active = 1').get(sopId);
    if (!sop) throw new NotFoundError('SOP');

    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId);
    if (!warehouse) throw new NotFoundError('仓库');

    if (outputMaterialId) {
        const mat = db.prepare('SELECT * FROM materials WHERE id = ? AND is_active = 1').get(outputMaterialId);
        if (!mat) throw new NotFoundError('产出物料');
    }

    const doCreate = db.transaction(() => {
        const orderNo = generateOrderNo(db);
        const snapshots = buildProductionSnapshots(db, {
            sopId,
            warehouseId,
            plannedQuantity,
            outputMaterialId,
            notes
        });
        const id = db.prepare(`
            INSERT INTO production_orders (
                order_no, sop_id, warehouse_id, output_material_id, planned_quantity, notes,
                snapshot_created_at, sop_snapshot_json, bom_snapshot_json, workorder_snapshot_json,
                created_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            orderNo,
            sopId,
            warehouseId,
            outputMaterialId || null,
            plannedQuantity,
            notes || null,
            snapshots.snapshotCreatedAt,
            JSON.stringify(snapshots.sopSnapshot),
            snapshots.bomSnapshot ? JSON.stringify(snapshots.bomSnapshot) : null,
            JSON.stringify(snapshots.workorderSnapshot),
            req.session.user.id
        ).lastInsertRowid;
        return { id, orderNo };
    });

    const { id, orderNo } = doCreate();

    logOperation({
        userId: req.session.user.id, action: 'create', resource: 'production',
        resourceId: id, detail: `创建生产工单 ${orderNo}，SOP: ${sop.title}，计划数量: ${plannedQuantity}`, ip: req.ip
    });

    res.status(201).json({ success: true, data: { id, orderNo } });
});

/**
 * PUT /api/production/:id/status
 * 更新工单状态: planned → in_progress → completed, or → cancelled
 */
router.put('/:id/status', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const { status } = req.body;
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');

    // 状态机校验
    const validTransitions = {
        'planned': ['in_progress', 'cancelled'],
        'in_progress': ['completed', 'cancelled'],
        'completed': [],
        'cancelled': []
    };

    if (!validTransitions[order.status]?.includes(status)) {
        throw new ValidationError(`无法从"${order.status}"变更为"${status}"`);
    }

    const statusLabels = { planned: '计划中', in_progress: '生产中', completed: '已完成', cancelled: '已取消' };

    const doStatusChange = db.transaction(() => {
        // 开始生产：扣减物料库存
        if (status === 'in_progress') {
            if (order.issue_document_id) {
                throw new ConflictError('该工单已生成领料单据，不能重复开始');
            }

            const materials = fetchProductionMaterials(db, order, order.planned_quantity);

            // 检查库存
            const insufficient = materials.filter(m => {
                const available = m.selected_substitution ? Number(m.effective_available_stock || 0) : Number(m.available || 0);
                return available < m.total_needed;
            });
            if (insufficient.length > 0) {
                const msg = insufficient.map(m => {
                    if (m.selected_substitution) {
                        return `${m.name}: 已选替代料 ${m.selected_substitution.substituteMaterialName} 库存 ${m.effective_available_stock} ${m.unit}，需要 ${m.total_needed} ${m.unit}`;
                    }
                    return `${m.name}: 库存 ${m.available} ${m.unit}，需要 ${m.total_needed} ${m.unit}`;
                }).join('\n');
                throw new ValidationError('物料不足，无法开始生产:\n' + msg);
            }

            const issueDocument = createDocument(
                db,
                buildProductionIssueDocumentPayload(order, materials),
                req.session.user.id,
                'submitted'
            );
            executeDocument(db, issueDocument.id, req.session.user.id);
            postDocument(db, issueDocument.id, req.session.user.id);

            db.prepare(`
                UPDATE production_orders
                SET status = 'in_progress',
                    started_at = datetime('now','localtime'),
                    issue_document_id = ?,
                    substitution_executed_json = ?,
                    workorder_snapshot_json = ?
                WHERE id = ?
            `).run(
                issueDocument.id,
                JSON.stringify(materials.filter(item => item.selected_substitution).map(item => ({
                    originalMaterialId: item.material_id,
                    originalMaterialName: item.name,
                    substituteMaterialId: item.selected_substitution.substituteMaterialId,
                    substituteMaterialName: item.selected_substitution.substituteMaterialName,
                    substitutionType: item.selected_substitution.substitutionType,
                    reason: item.selected_substitution.reason || null,
                    quantity: Number(item.total_needed || 0)
                }))),
                JSON.stringify({
                    ...(safeParseJSON(order.workorder_snapshot_json, {}) || {}),
                    substitutionPlan: getOrderSubstitutionPlan(order),
                    substitutionExecuted: materials.filter(item => item.selected_substitution).map(item => ({
                        originalMaterialId: item.material_id,
                        originalMaterialName: item.name,
                        substituteMaterialId: item.selected_substitution.substituteMaterialId,
                        substituteMaterialName: item.selected_substitution.substituteMaterialName,
                        substitutionType: item.selected_substitution.substitutionType,
                        reason: item.selected_substitution.reason || null,
                        quantity: Number(item.total_needed || 0)
                    }))
                }),
                order.id
            );
        }
        // 完成生产：产出物料入库
        else if (status === 'completed') {
            const remainingQty = getOrderRemainingQuantity(order);
            const nextCompletedQuantity = Number(order.completed_quantity || 0) + remainingQty;

            if (remainingQty <= 0) {
                db.prepare(`
                    UPDATE production_orders
                    SET status = 'completed',
                        completed_at = COALESCE(completed_at, datetime('now','localtime'))
                    WHERE id = ?
                `).run(order.id);
                return;
            }

            if (order.output_material_id) {
                const receiptDocument = createDocument(
                    db,
                    buildProductionReceiptDocumentPayload(order, remainingQty),
                    req.session.user.id,
                    'submitted'
                );
                executeDocument(db, receiptDocument.id, req.session.user.id);
                postDocument(db, receiptDocument.id, req.session.user.id);

                db.prepare(`
                    UPDATE production_orders
                    SET status = 'completed',
                        completed_quantity = ?,
                        completed_at = datetime('now','localtime'),
                        receipt_document_id = ?
                    WHERE id = ?
                `).run(nextCompletedQuantity, receiptDocument.id, order.id);
                return;
            }

            db.prepare("UPDATE production_orders SET status = 'completed', completed_quantity = ?, completed_at = datetime('now','localtime') WHERE id = ?")
                .run(nextCompletedQuantity, order.id);
        }
        // 取消：退回已领物料
        else if (status === 'cancelled') {
            if (order.status === 'in_progress') {
                if (Number(order.completed_quantity || 0) > 0) {
                    throw new ValidationError('该工单已有部分完工，请先使用“部分退料”处理剩余数量，再将工单完结');
                }
                const remainingQty = getOrderRemainingQuantity(order);
                if (remainingQty <= 0) {
                    db.prepare("UPDATE production_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
                    return;
                }
                const materials = fetchProductionMaterials(db, order, remainingQty);
                const returnDocument = createDocument(
                    db,
                    buildProductionReturnDocumentPayload(order, materials, remainingQty),
                    req.session.user.id,
                    'submitted'
                );
                executeDocument(db, returnDocument.id, req.session.user.id);
                postDocument(db, returnDocument.id, req.session.user.id);

                db.prepare(`
                    UPDATE production_orders
                    SET status = 'cancelled',
                        returned_quantity = ?,
                        return_document_id = ?
                    WHERE id = ?
                `).run(Number(order.planned_quantity || 0), returnDocument.id, order.id);
                return;
            }

            db.prepare("UPDATE production_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
        }
    });

    doStatusChange();

    logOperation({
        userId: req.session.user.id, action: 'update', resource: 'production',
        resourceId: order.id,
        detail: `工单 ${order.order_no} 状态: ${statusLabels[order.status]} → ${statusLabels[status]}`,
        ip: req.ip
    });

    res.json({ success: true });
});

/**
 * PUT /api/production/:id/complete-partial
 * 部分完工入库
 */
router.put('/:id/complete-partial', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const completedQuantity = Number(req.body.completedQuantity);
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');
    if (order.status !== 'in_progress') throw new ValidationError('只有生产中的工单可以做部分完工');
    if (!completedQuantity || completedQuantity <= 0) throw new ValidationError('本次完工数量必须大于0');

    const remainingQty = getOrderRemainingQuantity(order);
    if (completedQuantity > remainingQty) {
        throw new ValidationError(`本次完工数量不能超过剩余待处理数量 ${remainingQty}`);
    }
    if (!order.output_material_id) throw new ValidationError('当前工单未设置产出物料，不能做完工入库');

    const doPartialComplete = db.transaction(() => {
        const receiptDocument = createDocument(
            db,
            buildProductionReceiptDocumentPayload(order, completedQuantity),
            req.session.user.id,
            'submitted'
        );
        executeDocument(db, receiptDocument.id, req.session.user.id);
        postDocument(db, receiptDocument.id, req.session.user.id);

        const nextCompletedQuantity = Number(order.completed_quantity || 0) + completedQuantity;
        const nextReturnedQuantity = getOrderReturnedQuantity(order);
        const nextStatus = closeOrderStatusForRemaining(order, nextCompletedQuantity, nextReturnedQuantity);

        db.prepare(`
            UPDATE production_orders
            SET completed_quantity = ?,
                status = ?,
                completed_at = CASE WHEN ? = 'completed' THEN datetime('now','localtime') ELSE completed_at END,
                receipt_document_id = ?
            WHERE id = ?
        `).run(nextCompletedQuantity, nextStatus, nextStatus, receiptDocument.id, order.id);

        return receiptDocument;
    });

    const document = doPartialComplete();

    logOperation({
        userId: req.session.user.id, action: 'update', resource: 'production',
        resourceId: order.id,
        detail: `工单 ${order.order_no} 部分完工 ${completedQuantity}`,
        ip: req.ip
    });

    res.json({ success: true, data: { document } });
});

/**
 * PUT /api/production/:id/return-partial
 * 部分退料回库
 */
router.put('/:id/return-partial', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const returnQuantity = Number(req.body.returnQuantity);
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');
    if (order.status !== 'in_progress') throw new ValidationError('只有生产中的工单可以做部分退料');
    if (!returnQuantity || returnQuantity <= 0) throw new ValidationError('本次退料对应数量必须大于0');

    const remainingQty = getOrderRemainingQuantity(order);
    if (returnQuantity > remainingQty) {
        throw new ValidationError(`本次退料对应数量不能超过剩余待处理数量 ${remainingQty}`);
    }

    const doPartialReturn = db.transaction(() => {
        const materials = fetchProductionMaterials(db, order, returnQuantity);
        const returnDocument = createDocument(
            db,
            buildProductionReturnDocumentPayload(order, materials, returnQuantity),
            req.session.user.id,
            'submitted'
        );
        executeDocument(db, returnDocument.id, req.session.user.id);
        postDocument(db, returnDocument.id, req.session.user.id);

        const nextCompletedQuantity = Number(order.completed_quantity || 0);
        const nextReturnedQuantity = getOrderReturnedQuantity(order) + returnQuantity;
        const nextStatus = closeOrderStatusForRemaining(order, nextCompletedQuantity, nextReturnedQuantity);

        db.prepare(`
            UPDATE production_orders
            SET returned_quantity = ?,
                status = ?,
                completed_at = CASE WHEN ? = 'completed' THEN datetime('now','localtime') ELSE completed_at END,
                return_document_id = ?
            WHERE id = ?
        `).run(nextReturnedQuantity, nextStatus, nextStatus, returnDocument.id, order.id);

        return returnDocument;
    });

    const document = doPartialReturn();

    logOperation({
        userId: req.session.user.id, action: 'update', resource: 'production',
        resourceId: order.id,
        detail: `工单 ${order.order_no} 部分退料 ${returnQuantity}`,
        ip: req.ip
    });

    res.json({ success: true, data: { document } });
});

/**
 * POST /api/production/:id/exceptions
 * 创建工单异常单
 */
router.post('/:id/exceptions', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');
    if (!['in_progress', 'completed'].includes(order.status)) {
        throw new ValidationError('只有生产中或已完成的工单允许登记异常单');
    }

    const exceptionType = String(req.body.type || '').trim();
    const allowedTypes = ['scrap', 'supplement', 'over_issue', 'variance'];
    if (!allowedTypes.includes(exceptionType)) throw new ValidationError('异常类型无效');

    let direction = req.body.direction ? String(req.body.direction).trim() : '';
    if (exceptionType === 'scrap' || exceptionType === 'supplement' || exceptionType === 'over_issue') {
        direction = 'out';
    }
    if (!['in', 'out'].includes(direction)) throw new ValidationError('异常方向无效');

    let materialId = req.body.materialId !== undefined && req.body.materialId !== null && req.body.materialId !== ''
        ? Number(req.body.materialId)
        : null;
    const quantity = Number(req.body.quantity);
    if (!quantity || quantity <= 0) throw new ValidationError('异常数量必须大于0');

    if (!materialId && exceptionType === 'scrap' && order.output_material_id) {
        materialId = Number(order.output_material_id);
    }
    if (!materialId) throw new ValidationError('请选择异常物料');

    const material = db.prepare('SELECT id, name, is_active FROM materials WHERE id = ?').get(materialId);
    if (!material || !material.is_active) throw new NotFoundError('物料');

    const notes = req.body.notes ? String(req.body.notes).trim() : null;

    const createException = db.transaction(() => {
        const exceptionNo = generateProductionExceptionNo(db);
        const insert = db.prepare(`
            INSERT INTO production_exceptions (
                exception_no, order_id, exception_type, direction, material_id, quantity, status, notes, created_by
            )
            VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?)
        `).run(
            exceptionNo,
            order.id,
            exceptionType,
            direction,
            materialId,
            quantity,
            notes,
            req.session.user.id
        );

        const exceptionId = insert.lastInsertRowid;
        const document = createDocument(
            db,
            {
                ...buildProductionExceptionDocumentPayload(order, exceptionType, direction, materialId, quantity, notes),
                originId: exceptionId
            },
            req.session.user.id,
            'submitted'
        );
        executeDocument(db, document.id, req.session.user.id);
        postDocument(db, document.id, req.session.user.id);

        db.prepare(`
            UPDATE production_exceptions
            SET stock_document_id = ?
            WHERE id = ?
        `).run(document.id, exceptionId);

        return db.prepare(`
            SELECT pe.*, m.name as material_name, m.code as material_code, m.unit
            FROM production_exceptions pe
            LEFT JOIN materials m ON pe.material_id = m.id
            WHERE pe.id = ?
        `).get(exceptionId);
    });

    const exception = createException();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'production',
        resourceId: order.id,
        detail: `工单 ${order.order_no} 新增异常单 ${exception.exception_no}：${exceptionType} ${quantity}`,
        ip: req.ip
    });

    res.status(201).json({
        success: true,
        data: {
            exception: {
                id: exception.id,
                exceptionNo: exception.exception_no,
                exceptionType: exception.exception_type,
                direction: exception.direction,
                materialId: exception.material_id,
                materialName: exception.material_name,
                materialCode: exception.material_code,
                quantity: Number(exception.quantity || 0),
                unit: exception.unit,
                notes: exception.notes || null,
                stockDocumentId: exception.stock_document_id,
                document: exception.stock_document_id ? getDocumentById(db, exception.stock_document_id) : null
            }
        }
    });
});

router.post('/:id/exceptions/:exceptionId/reverse', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');

    const reason = String(req.body?.reason || '').trim();
    if (!reason) throw new ValidationError('红冲原因不能为空', 'reason');

    const reverseExceptionTx = db.transaction(() => {
        const current = getProductionExceptionById(db, order.id, Number(req.params.exceptionId));
        if (current.isReversal) throw new ConflictError('红冲异常单不允许再次红冲');
        if (current.status !== 'posted') throw new ConflictError('只有已记账异常单允许红冲');
        if (current.reversedByExceptionId) throw new ConflictError('该异常单已生成红冲异常单');
        if (!current.stockDocumentId) throw new ConflictError('异常单缺少库存单据，不能红冲');

        const reversalDocument = reverseDocument(db, current.stockDocumentId, req.session.user.id, reason);
        const reversalNo = generateProductionExceptionNo(db);
        const insert = db.prepare(`
            INSERT INTO production_exceptions (
                exception_no, order_id, exception_type, direction, material_id, quantity,
                status, is_reversal, reversal_of_exception_id, reversal_reason, notes, stock_document_id, created_by
            )
            VALUES (?, ?, ?, ?, ?, ?, 'posted', 1, ?, ?, ?, ?, ?)
        `).run(
            reversalNo,
            order.id,
            current.exceptionType,
            current.direction,
            current.materialId,
            current.quantity,
            current.id,
            reason,
            [current.notes, `红冲原异常 ${current.exceptionNo}`, `原因: ${reason}`].filter(Boolean).join(' | '),
            reversalDocument.id,
            req.session.user.id
        );

        db.prepare(`
            UPDATE production_exceptions
            SET status = 'reversed',
                reversed_by_exception_id = ?,
                reversed_at = datetime('now', 'localtime'),
                reversal_reason = ?
            WHERE id = ?
        `).run(insert.lastInsertRowid, reason, current.id);

        return {
            original: getProductionExceptionById(db, order.id, current.id),
            reversal: getProductionExceptionById(db, order.id, insert.lastInsertRowid)
        };
    });

    const result = reverseExceptionTx();

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'production',
        resourceId: order.id,
        detail: `工单 ${order.order_no} 红冲异常单 ${result.original.exceptionNo}，生成 ${result.reversal.exceptionNo}`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            originalException: result.original,
            reversalException: result.reversal
        }
    });
});

/**
 * PUT /api/production/:id/progress
 * 更新已完成数量
 */
router.put('/:id/progress', requirePermission('production', 'edit'), (req, res) => {
    const db = getDB();
    const { completedQuantity } = req.body;
    const order = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(req.params.id);
    if (!order) throw new NotFoundError('生产工单');
    if (order.status !== 'in_progress') throw new ValidationError('只有生产中的工单可以更新进度');
    if (completedQuantity < 0 || completedQuantity > (Number(order.planned_quantity || 0) - getOrderReturnedQuantity(order))) throw new ValidationError('完成数量无效');

    db.prepare('UPDATE production_orders SET completed_quantity = ? WHERE id = ?').run(completedQuantity, order.id);

    res.json({ success: true });
});

module.exports = router;
