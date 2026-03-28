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
const multer = require('multer');
const ExcelJS = require('exceljs');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { logOperation } = require('../utils/logger');
const { ValidationError, NotFoundError, asyncHandler } = require('../utils/errors');
const { generatePinyinFields } = require('../utils/pinyin');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }
});
const bomImportPreviewStore = new Map();
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

function buildPreviewToken(prefix = 'preview') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanupPreviewStore(store) {
    const now = Date.now();
    for (const [token, entry] of store.entries()) {
        if (!entry || entry.expiresAt <= now) {
            store.delete(token);
        }
    }
}

function detectWorksheetHeaderRow(sheet, requiredHeaders) {
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 20); rowNumber++) {
        const values = sheet.getRow(rowNumber).values.slice(1).map(value => String(value || '').trim());
        if (requiredHeaders.every(header => values.includes(header))) {
            return rowNumber;
        }
    }
    return null;
}

function parseBomWorkbookCategory(row) {
    const parts = ['一级分类', '二级分类', '三级分类', '四级分类']
        .map(key => String(row[key] || '').trim())
        .filter(Boolean);
    return parts.join('-') || null;
}

async function parseProductionTemplateWorkbook(file) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ValidationError('Excel 中没有可用工作表');

    const headerRowNumber = detectWorksheetHeaderRow(sheet, ['模板编号', '生产模板名称', '成品编号', '商品编号', '配套数量']);
    if (!headerRowNumber) {
        throw new ValidationError('无法识别生产模板明细表头，请确认文件格式正确');
    }

    const headers = [];
    sheet.getRow(headerRowNumber).eachCell((cell, colNumber) => {
        headers[colNumber] = String(cell.value || '').trim();
    });

    const rows = [];
    for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        const record = {};
        let hasValue = false;
        headers.forEach((header, colNumber) => {
            if (!header) return;
            let value = row.getCell(colNumber).value;
            if (value && typeof value === 'object' && value.result !== undefined) value = value.result;
            if (value && typeof value === 'object' && value.text) value = value.text;
            record[header] = value ?? '';
            if (value !== null && value !== undefined && String(value).trim() !== '') hasValue = true;
        });
        if (!hasValue) continue;
        rows.push({
            rowNumber,
            templateCode: String(record['模板编号'] || '').trim(),
            templateName: String(record['生产模板名称'] || '').trim() || String(record['模板编号'] || '').trim(),
            outputCode: String(record['成品编号'] || '').trim(),
            outputName: String(record['成品名称'] || '').trim(),
            outputUnit: String(record['单位'] || '').trim() || null,
            category: parseBomWorkbookCategory(record),
            description: String(record['模板备注'] || '').trim() || null,
            status: String(record['状态'] || '').trim() === '启用' ? 'active' : 'draft',
            itemCode: String(record['商品编号'] || '').trim(),
            itemName: String(record['商品名称'] || '').trim(),
            quantity: Number(record['配套数量'] || 0),
            unit: String(record['明细--单位'] || '').trim() || String(record['单位'] || '').trim() || '件'
        });
    }

    return rows.filter(row => row.templateCode || row.templateName);
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

const BOM_LEVEL_OPTIONS = ['整机', '模块', '板级', '配套件'];
const BOM_NAMING_FORBIDDEN_TOKENS = ['.BOM', 'BOM', '模板', '最新版', '最终版', '新版', '改版'];

function inferBomLevelFromName(name = '') {
    const normalized = String(name || '').trim();
    const matched = BOM_LEVEL_OPTIONS.find(level => normalized.startsWith(`${level}_`) || normalized.startsWith(level));
    return matched || null;
}

function normalizeDisplayVersion(value, fallback = 'V01') {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return fallback;
    const directMatch = raw.match(/^V(\d{2})$/);
    if (directMatch) return `V${directMatch[1]}`;
    const decimalMatch = raw.match(/^(\d+)(?:\.(\d+))?$/);
    if (decimalMatch) {
        const major = Number(decimalMatch[1] || 0);
        return `V${String(Math.max(major, 1)).padStart(2, '0')}`;
    }
    const looseMatch = raw.match(/(\d{1,2})/);
    if (looseMatch) return `V${String(Number(looseMatch[1] || 1)).padStart(2, '0')}`;
    return fallback;
}

function sanitizeBomNameCore(name = '', level = '') {
    let value = String(name || '').trim();
    if (level) {
        value = value.replace(new RegExp(`^${level}[ _-]*`), '');
    }
    value = value
        .replace(/20\d{2}[-/.年]?\d{1,2}[-/.月]?\d{1,2}日?/g, ' ')
        .replace(/20\d{6}/g, ' ')
        .replace(/[【】[\]()（）]/g, ' ')
        .replace(/\bV\d{2}\b/gi, ' ');
    BOM_NAMING_FORBIDDEN_TOKENS.forEach(token => {
        value = value.replace(new RegExp(token.replace('.', '\\.'), 'gi'), ' ');
    });
    value = value
        .replace(/[\\/]+/g, '_')
        .replace(/[，,；;、]+/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return value || '未命名对象';
}

function evaluateBomNaming(payload = {}) {
    const name = String(payload.name || '').trim();
    const bomLevel = String(payload.bomLevel || '').trim() || inferBomLevelFromName(name) || '';
    const displayVersion = normalizeDisplayVersion(payload.displayVersion || '', 'V01');
    const issues = [];
    const issueCodes = new Set();

    function addIssue(code, label, severity = 'warning') {
        if (issueCodes.has(code)) return;
        issueCodes.add(code);
        issues.push({ code, label, severity });
    }

    if (!bomLevel) addIssue('missing_level', '未设置 BOM 层级', 'warning');
    if (payload.bomLevel && name && !name.startsWith(`${payload.bomLevel}_`)) {
        addIssue('prefix_mismatch', '名称未按“层级_”前缀命名', 'error');
    }
    if (!/^V\d{2}$/.test(displayVersion)) {
        addIssue('invalid_display_version', '显示版本应为 V01 / V02 格式', 'error');
    }
    if (name && !new RegExp(`_${displayVersion}$`, 'i').test(name)) {
        addIssue('missing_version_suffix', '名称未以标准版本尾缀结尾', 'warning');
    }
    if (/20\d{2}[-/.年]?\d{1,2}[-/.月]?\d{1,2}日?/.test(name) || /20\d{6}/.test(name)) {
        addIssue('date_in_name', '名称中包含日期信息', 'error');
    }
    BOM_NAMING_FORBIDDEN_TOKENS.forEach(token => {
        if (token === 'BOM') {
            if (/\bBOM\b/i.test(name) || /\.BOM/i.test(name)) addIssue(`forbidden_${token}`, `名称中包含禁用词 ${token}`, 'error');
            return;
        }
        if (name.includes(token)) addIssue(`forbidden_${token}`, `名称中包含禁用词 ${token}`, 'error');
    });

    const suggestedCore = sanitizeBomNameCore(name, bomLevel || inferBomLevelFromName(name) || '');
    const suggestedName = [bomLevel || '模块', suggestedCore, displayVersion].filter(Boolean).join('_');
    const hasError = issues.some(item => item.severity === 'error');
    const status = !issues.length ? 'compliant' : hasError ? 'non_compliant' : 'warning';

    return {
        bomLevel: bomLevel || null,
        displayVersion,
        namingStatus: status,
        namingIssues: issues,
        suggestedName
    };
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

    const { namingStatus, bomLevel } = req.query;
    if (status) { whereClauses.push('b.status = ?'); params.push(status); }
    if (namingStatus) { whereClauses.push('COALESCE(b.naming_status, ?) = ?'); params.push('warning', namingStatus); }
    if (bomLevel) { whereClauses.push('COALESCE(b.bom_level, ?) = ?'); params.push('', bomLevel); }
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

router.get('/naming-governance/summary', requirePermission('boms', 'view'), (req, res) => {
    const db = getDB();
    const { q = '', namingStatus = '', bomLevel = '' } = req.query;
    let whereClauses = ['b.is_active = 1'];
    const params = [];
    if (q) {
        const term = `%${String(q).toLowerCase()}%`;
        whereClauses.push('(LOWER(b.name) LIKE ? OR LOWER(COALESCE(b.code, \'\')) LIKE ?)');
        params.push(term, term);
    }
    if (namingStatus) {
        whereClauses.push('COALESCE(b.naming_status, ?) = ?');
        params.push('warning', namingStatus);
    }
    if (bomLevel) {
        whereClauses.push('COALESCE(b.bom_level, ?) = ?');
        params.push('', bomLevel);
    }
    const whereSQL = whereClauses.join(' AND ');
    const items = db.prepare(`
        SELECT b.id, b.name, b.code, b.version, b.display_version, b.bom_level, b.status,
               COALESCE(b.naming_status, 'warning') as naming_status,
               b.naming_issues_json, b.suggested_name, b.updated_at,
               om.name as output_material_name,
               (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id) as item_count
        FROM boms b
        LEFT JOIN materials om ON b.output_material_id = om.id
        WHERE ${whereSQL}
        ORDER BY CASE COALESCE(b.naming_status, 'warning')
            WHEN 'non_compliant' THEN 1
            WHEN 'warning' THEN 2
            ELSE 3 END,
            b.updated_at DESC
    `).all(...params).map(item => ({
        ...item,
        naming_issues: item.naming_issues_json ? JSON.parse(item.naming_issues_json) : []
    }));

    const summary = {
        total: items.length,
        compliant: items.filter(item => item.naming_status === 'compliant').length,
        warning: items.filter(item => item.naming_status === 'warning').length,
        nonCompliant: items.filter(item => item.naming_status === 'non_compliant').length
    };

    res.json({ success: true, data: { summary, items } });
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

    const tree = expandBom(db, bom.id);
    const flatItems = flattenBom(tree);
    const totalCost = tree.reduce((sum, item) => sum + (item.line_cost || 0), 0);

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

router.post('/import/preview', requirePermission('boms', 'add'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('请选择生产模板明细文件');

    cleanupPreviewStore(bomImportPreviewStore);
    const db = getDB();
    const rows = await parseProductionTemplateWorkbook(req.file);
    if (!rows.length) throw new ValidationError('生产模板明细中没有可导入的 BOM 数据');

    const materials = db.prepare('SELECT id, code, name FROM materials WHERE is_active = 1').all();
    const materialsByCode = new Map(materials.filter(item => item.code).map(item => [item.code, item]));
    const materialsByName = new Map(materials.filter(item => item.name).map(item => [item.name, item]));

    const grouped = new Map();
    rows.forEach(row => {
        const key = row.templateCode || row.templateName;
        if (!grouped.has(key)) {
            grouped.set(key, {
                templateCode: row.templateCode,
                templateName: row.templateName,
                outputCode: row.outputCode,
                outputName: row.outputName,
                outputUnit: row.outputUnit,
                category: row.category,
                description: row.description,
                status: row.status,
                rows: []
            });
        }
        grouped.get(key).rows.push(row);
    });

    const items = [];
    const summary = { total: grouped.size, creatable: 0, updatable: 0, invalid: 0, itemCount: rows.length };
    for (const group of grouped.values()) {
        const outputMaterial = (group.outputCode && materialsByCode.get(group.outputCode))
            || (group.outputName && materialsByName.get(group.outputName))
            || null;
        const existingBom = db.prepare(`
            SELECT id, name, code, version
            FROM boms
            WHERE is_active = 1 AND (name = ? OR name = ?)
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
        `).get(group.templateName, group.templateCode || group.templateName);

        const previewItem = {
            key: group.templateCode || group.templateName,
            action: existingBom ? 'update' : 'create',
            name: group.templateName,
            templateCode: group.templateCode,
            outputCode: group.outputCode,
            outputName: group.outputName,
            outputMaterialId: outputMaterial?.id || null,
            materialCount: group.rows.length,
            category: group.category,
            status: group.status,
            rows: group.rows,
            warnings: [],
            errors: []
        };

        if (!group.templateName) previewItem.errors.push('生产模板名称不能为空');
        if (!outputMaterial) previewItem.errors.push(`找不到产出物料：${group.outputCode || group.outputName || '未填写'}`);

        previewItem.items = group.rows.map(detail => {
            const material = (detail.itemCode && materialsByCode.get(detail.itemCode))
                || (detail.itemName && materialsByName.get(detail.itemName))
                || null;
            const detailItem = {
                row: detail.rowNumber,
                itemCode: detail.itemCode,
                itemName: detail.itemName,
                quantity: detail.quantity,
                materialId: material?.id || null,
                errors: []
            };
            if (!material) detailItem.errors.push(`找不到明细物料：${detail.itemCode || detail.itemName || '未填写'}`);
            if (!detail.quantity || Number.isNaN(detail.quantity) || detail.quantity <= 0) detailItem.errors.push('配套数量必须大于 0');
            if (detailItem.errors.length > 0) {
                previewItem.errors.push(`第 ${detail.rowNumber} 行：${detailItem.errors.join('，')}`);
            }
            return detailItem;
        });

        if (existingBom) {
            previewItem.bomId = existingBom.id;
            previewItem.version = existingBom.version;
            summary.updatable++;
        } else {
            summary.creatable++;
        }

        if (previewItem.errors.length > 0) {
            previewItem.action = 'invalid';
            summary.invalid++;
            if (existingBom) summary.updatable--;
            else summary.creatable--;
        }

        items.push(previewItem);
    }

    const previewToken = buildPreviewToken('bom_import');
    bomImportPreviewStore.set(previewToken, {
        createdBy: req.session.user.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        items,
        summary
    });

    res.json({ success: true, data: { previewToken, summary, items } });
}));

router.post('/import/commit', requirePermission('boms', 'add'), (req, res) => {
    cleanupPreviewStore(bomImportPreviewStore);
    const { previewToken } = req.body || {};
    if (!previewToken) throw new ValidationError('缺少 previewToken');
    const preview = bomImportPreviewStore.get(previewToken);
    if (!preview || preview.createdBy !== req.session.user.id) {
        throw new ValidationError('BOM 导入预览已失效，请重新上传文件');
    }

    const invalidItems = preview.items.filter(item => item.action === 'invalid');
    if (invalidItems.length > 0) {
        throw new ValidationError(`存在 ${invalidItems.length} 个无效 BOM，无法提交`);
    }

    const db = getDB();
    const doCommit = db.transaction(() => {
        let imported = 0;
        let updated = 0;

        preview.items.forEach(item => {
            const name = item.name;
            const naming = evaluateBomNaming({
                name,
                bomLevel: inferBomLevelFromName(name),
                displayVersion: item.version || 'V01'
            });
            const { fullPinyin, abbr } = generatePinyinFields(name);

            if (item.bomId) {
                const bom = db.prepare('SELECT * FROM boms WHERE id = ?').get(item.bomId);
                const currentItems = db.prepare('SELECT * FROM bom_items WHERE bom_id = ? ORDER BY sort_order').all(item.bomId);
                const snapshot = JSON.stringify({
                    name: bom.name,
                    code: bom.code,
                    version: bom.version,
                    outputMaterialId: bom.output_material_id,
                    outputQuantity: bom.output_quantity,
                    category: bom.category,
                    description: bom.description,
                    items: currentItems
                });
                db.prepare(`
                    INSERT INTO bom_versions (bom_id, version, snapshot, change_notes, created_by)
                    VALUES (?, ?, ?, ?, ?)
                `).run(item.bomId, bom.version, snapshot, '生产模板明细导入自动备份', req.session.user.id);

                let newVersion = bom.version;
                const parts = String(bom.version || '1.0').split('.');
                if (parts.length >= 2) {
                    parts[parts.length - 1] = String((parseInt(parts[parts.length - 1], 10) || 0) + 1);
                    newVersion = parts.join('.');
                } else {
                    newVersion = `${bom.version || '1.0'}.1`;
                }

                db.prepare(`
                    UPDATE boms
                    SET name = ?, output_material_id = ?, output_quantity = 1, category = ?, description = ?, status = ?,
                        version = ?, name_pinyin = ?, name_pinyin_abbr = ?, updated_at = datetime('now','localtime'),
                        bom_level = ?, display_version = ?, naming_status = ?, naming_issues_json = ?, suggested_name = ?, naming_checked_at = datetime('now','localtime')
                    WHERE id = ?
                `).run(
                    name,
                    item.outputMaterialId,
                    item.category || null,
                    item.rows[0]?.description || null,
                    item.status || 'active',
                    newVersion,
                    fullPinyin,
                    abbr,
                    naming.bomLevel,
                    naming.displayVersion,
                    naming.namingStatus,
                    JSON.stringify(naming.namingIssues),
                    naming.suggestedName,
                    item.bomId
                );

                db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(item.bomId);
                item.items.forEach((detail, index) => {
                    db.prepare(`
                        INSERT INTO bom_items (bom_id, material_id, quantity, sort_order)
                        VALUES (?, ?, ?, ?)
                    `).run(item.bomId, detail.materialId, detail.quantity, index);
                });
                updated++;
            } else {
                const code = generateBomCode(db);
                const result = db.prepare(`
                    INSERT INTO boms (name, code, output_material_id, output_quantity, category, description, status, name_pinyin, name_pinyin_abbr, created_by,
                                      bom_level, display_version, naming_status, naming_issues_json, suggested_name, naming_checked_at)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                `).run(
                    name,
                    code,
                    item.outputMaterialId,
                    item.category || null,
                    item.rows[0]?.description || null,
                    item.status || 'active',
                    fullPinyin,
                    abbr,
                    req.session.user.id,
                    naming.bomLevel,
                    naming.displayVersion,
                    naming.namingStatus,
                    JSON.stringify(naming.namingIssues),
                    naming.suggestedName
                );
                const bomId = Number(result.lastInsertRowid);
                item.items.forEach((detail, index) => {
                    db.prepare(`
                        INSERT INTO bom_items (bom_id, material_id, quantity, sort_order)
                        VALUES (?, ?, ?, ?)
                    `).run(bomId, detail.materialId, detail.quantity, index);
                });
                imported++;
            }
        });

        return { total: preview.items.length, imported, updated };
    });

    const result = doCommit();
    bomImportPreviewStore.delete(previewToken);

    logOperation({
        userId: req.session.user.id,
        action: 'import',
        resource: 'boms',
        detail: `导入生产模板明细：新增 ${result.imported}，更新 ${result.updated}，共 ${result.total} 个 BOM`,
        ip: req.ip
    });

    res.json({ success: true, data: result });
});

/**
 * POST /api/boms
 */
router.post('/', requirePermission('boms', 'add'), (req, res) => {
    const db = getDB();
    const { name, outputMaterialId, outputQuantity = 1, category, description, status = 'active', items = [], bomLevel, displayVersion } = req.body;

    if (!name || !name.trim()) throw new ValidationError('BOM 名称不能为空');

    const naming = evaluateBomNaming({ name, bomLevel, displayVersion });
    const { fullPinyin, abbr } = generatePinyinFields(name.trim());

    if (outputMaterialId) {
        const mat = db.prepare('SELECT id FROM materials WHERE id = ? AND is_active = 1').get(outputMaterialId);
        if (!mat) throw new NotFoundError('产出物料');
    }

    const doCreate = db.transaction(() => {
        const code = generateBomCode(db);
        const result = db.prepare(`
            INSERT INTO boms (name, code, output_material_id, output_quantity, category, description, status, name_pinyin, name_pinyin_abbr, created_by,
                              bom_level, display_version, naming_status, naming_issues_json, suggested_name, naming_checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
        `).run(
            name.trim(), code, outputMaterialId || null, outputQuantity, category || null, description || null, status,
            fullPinyin, abbr, req.session.user.id,
            naming.bomLevel, naming.displayVersion, naming.namingStatus, JSON.stringify(naming.namingIssues), naming.suggestedName
        );

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

    res.status(201).json({ success: true, data: { id: bomId, code, naming } });
});

/**
 * PUT /api/boms/:id
 */
router.put('/:id', requirePermission('boms', 'edit'), (req, res) => {
    const db = getDB();
    const bom = db.prepare('SELECT * FROM boms WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!bom) throw new NotFoundError('BOM');

    const { name, outputMaterialId, outputQuantity, category, description, status, items = [], changeNotes, bomLevel, displayVersion } = req.body;

    if (!name || !name.trim()) throw new ValidationError('BOM 名称不能为空');
    if (status && status !== 'active') {
        const snapshotRefs = findBomSnapshotReferences(db, bom.id);
        if (snapshotRefs.length > 0) {
            const sampleOrders = snapshotRefs.slice(0, 5).map(order => order.order_no).join('、');
            throw new ValidationError(`该BOM已被 ${snapshotRefs.length} 张工单快照引用${sampleOrders ? `（${sampleOrders}）` : ''}，无法改为非 active 状态`);
        }
    }

    const naming = evaluateBomNaming({ name, bomLevel, displayVersion });
    const { fullPinyin, abbr } = generatePinyinFields(name.trim());

    const doUpdate = db.transaction(() => {
        // 保存版本快照
        const currentItems = db.prepare('SELECT * FROM bom_items WHERE bom_id = ? ORDER BY sort_order').all(bom.id);
        const snapshot = JSON.stringify({
            name: bom.name, code: bom.code, version: bom.version,
            outputMaterialId: bom.output_material_id, outputQuantity: bom.output_quantity,
            category: bom.category, description: bom.description,
            bomLevel: bom.bom_level || null, displayVersion: bom.display_version || null,
            namingStatus: bom.naming_status || 'warning', suggestedName: bom.suggested_name || null,
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
                            status=?, version=?, name_pinyin=?, name_pinyin_abbr=?, updated_at=datetime('now','localtime'),
                            bom_level=?, display_version=?, naming_status=?, naming_issues_json=?, suggested_name=?, naming_checked_at=datetime('now','localtime')
            WHERE id = ?
        `).run(name.trim(), outputMaterialId || null, outputQuantity || 1, category || null, description || null,
               status || 'active', newVersion, fullPinyin, abbr,
               naming.bomLevel, naming.displayVersion, naming.namingStatus, JSON.stringify(naming.namingIssues), naming.suggestedName,
               bom.id);

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

    res.json({ success: true, data: { version: newVersion, naming } });
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
    const naming = evaluateBomNaming({
        name: newName,
        bomLevel: src.bom_level || inferBomLevelFromName(src.name),
        displayVersion: src.display_version || src.version
    });
    const { fullPinyin, abbr } = generatePinyinFields(newName);

    const doDuplicate = db.transaction(() => {
        const code = generateBomCode(db);
        const result = db.prepare(`
            INSERT INTO boms (name, code, output_material_id, output_quantity, category, description, status, name_pinyin, name_pinyin_abbr, created_by,
                              bom_level, display_version, naming_status, naming_issues_json, suggested_name, naming_checked_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
        `).run(
            newName, code, src.output_material_id, src.output_quantity, src.category, src.description,
            fullPinyin, abbr, req.session.user.id,
            naming.bomLevel, naming.displayVersion, naming.namingStatus, JSON.stringify(naming.namingIssues), naming.suggestedName
        );

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
