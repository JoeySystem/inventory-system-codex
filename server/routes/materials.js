/**
 * 物料管理路由
 * GET    /api/materials          - 物料列表（支持拼音搜索、分页、筛选）
 * POST   /api/materials          - 创建物料
 * GET    /api/materials/:id      - 物料详情
 * PUT    /api/materials/:id      - 修改物料
 * DELETE /api/materials/:id      - 删除（软删除）物料
 * GET    /api/materials/export/csv - 导出物料CSV
 * POST   /api/materials/batch-import - 批量导入（预留）
 */

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { ValidationError, NotFoundError, ConflictError, asyncHandler } = require('../utils/errors');
const { generatePinyinFields, buildSearchCondition } = require('../utils/pinyin');
const { logOperation } = require('../utils/logger');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});
const importPreviewStore = new Map();
const inventoryWorkbookPreviewStore = new Map();
const supplierPricePreviewStore = new Map();

const MATERIAL_TYPES = ['raw', 'wip', 'finished', 'consumable', 'packaging', 'spare', 'virtual'];
const LIFECYCLE_STATUSES = ['draft', 'pending_review', 'active', 'frozen', 'inactive', 'obsolete'];
const SUPPLY_MODES = ['purchase_only', 'direct_issue', 'prebuild_wip', 'on_site_fabrication'];
const SUPPLIER_TYPES = ['manufacturer', 'distributor', 'agent', 'marketplace', 'retail', 'other'];
const SOURCE_PLATFORMS = ['factory_direct', 'taobao', '1688', 'jd', 'pdd', 'wechat', 'offline', 'other'];

// 所有物料接口需要登录
router.use(requireAuth);

/**
 * 自动生成物料编码 MAT-YYYYMMDD-NNN
 */
function generateMaterialCode(db) {
    const today = new Date();
    const dateStr = today.getFullYear().toString() +
        String(today.getMonth() + 1).padStart(2, '0') +
        String(today.getDate()).padStart(2, '0');
    const prefix = `MAT-${dateStr}-`;

    const last = db.prepare(
        "SELECT code FROM materials WHERE code LIKE ? ORDER BY code DESC LIMIT 1"
    ).get(`${prefix}%`);

    let seq = 1;
    if (last) {
        const lastSeq = parseInt(last.code.split('-').pop(), 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    return `${prefix}${String(seq).padStart(3, '0')}`;
}

function parseBooleanFlag(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return value ? 1 : 0;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(normalized)) return 1;
    if (['0', 'false', 'no'].includes(normalized)) return 0;
    throw new ValidationError(`无效的布尔值: ${value}`);
}

function parseNumberField(value, fieldName) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) throw new ValidationError(`${fieldName} 必须是数字`, fieldName);
    return parsed;
}

function trimText(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const result = String(value).trim();
    return result || null;
}

function normalizeMaterialUnit(value, fallback = null) {
    const raw = trimText(value);
    if (!raw) return fallback;

    const text = String(raw).trim();
    const upper = text.toUpperCase();
    const aliasMap = {
        PCS: 'PCS',
        PC: 'PCS',
        PIECE: 'PCS',
        PIECES: 'PCS',
        个: 'PCS',
        件: 'PCS',
        EA: 'PCS',
        SET: 'SET',
        套: 'SET',
        M: 'M',
        米: 'M',
        公尺: 'M',
        CM: 'CM',
        厘米: 'CM',
        MM: 'MM',
        毫米: 'MM',
        KG: 'KG',
        千克: 'KG',
        公斤: 'KG',
        G: 'G',
        克: 'G',
        L: 'L',
        升: 'L',
        ML: 'ML',
        毫升: 'ML',
        BOX: 'BOX',
        箱: 'BOX',
        ROLL: 'ROLL',
        卷: 'ROLL',
        PAIR: 'PAIR',
        双: 'PAIR'
    };

    return aliasMap[upper] || aliasMap[text] || upper;
}

function hasTable(db, tableName) {
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);
    return !!row;
}

function buildSpecKey(name, spec, brand, unit) {
    return [name, spec, brand, unit]
        .map(item => (item || '').trim().toLowerCase())
        .join('|');
}

function evaluateMaterialNaming({ name, code, spec, brand, unit, materialType }) {
    const materialName = trimText(name) || '';
    const materialCode = trimText(code) || '';
    const normalizedSpec = trimText(spec) || '';
    const normalizedBrand = trimText(brand) || '';
    const normalizedUnit = normalizeMaterialUnit(unit, null) || '';
    const issues = [];
    const addIssue = (codeValue, label, severity = 'warning') => issues.push({ code: codeValue, label, severity });

    if (!materialName) {
        addIssue('missing_name', '缺少物料名称', 'error');
    }
    if (!materialCode) {
        addIssue('missing_code', '缺少物料编码', 'warning');
    }
    if (materialName && materialName.length < 2) {
        addIssue('short_name', '名称过短，不利于识别', 'warning');
    }
    if (/[0-9]{4}[-./年]?[0-9]{1,2}[-./月]?[0-9]{1,2}/.test(materialName)) {
        addIssue('date_in_name', '名称中包含日期，建议移入备注或版本信息', 'warning');
    }
    if (/(最新版|最终版|模板|测试|test|样品)/i.test(materialName)) {
        addIssue('status_noise', '名称中包含状态/临时性描述，建议移入备注', 'warning');
    }
    if (/[【】]/.test(materialName)) {
        addIssue('fancy_delimiter', '名称中使用了【】等装饰符号，建议改为普通结构化命名', 'warning');
    }
    if (/\s{2,}/.test(materialName)) {
        addIssue('multi_space', '名称中存在多余空格', 'warning');
    }
    if (!normalizedUnit) {
        addIssue('missing_unit', '缺少基础单位', 'error');
    }
    if (materialType === 'raw' && !normalizedSpec) {
        addIssue('missing_spec', '原材料缺少规格型号，建议补充', 'warning');
    }

    const cleanedName = materialName
        .replace(/[【】]/g, '')
        .replace(/[0-9]{4}[-./年]?[0-9]{1,2}[-./月]?[0-9]{1,2}/g, '')
        .replace(/(最新版|最终版|模板|测试|test|样品)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    const suggestionParts = [cleanedName || materialName, normalizedSpec, normalizedBrand, normalizedUnit].filter(Boolean);

    return {
        namingStatus: !issues.length ? 'compliant' : issues.some(item => item.severity === 'error') ? 'non_compliant' : 'warning',
        namingIssues: issues,
        suggestedName: suggestionParts.join(' / ')
    };
}

function getImportField(row, aliases) {
    for (const alias of aliases) {
        if (!Object.prototype.hasOwnProperty.call(row, alias)) continue;
        const value = row[alias];
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        return value;
    }
    return undefined;
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
        const values = sheet.getRow(rowNumber).values
            .slice(1)
            .map(value => String(value || '').trim());
        if (requiredHeaders.every(header => values.includes(header))) {
            return rowNumber;
        }
    }
    return null;
}

function mapInventoryWorkbookCategory(row) {
    const parts = ['一级分类', '二级分类', '三级分类', '四级分类']
        .map(key => trimText(row[key]))
        .filter(Boolean);
    return parts.join('-') || null;
}

async function parseInventoryWorkbook(file) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ValidationError('Excel 中没有可用工作表');

    const headerRowNumber = detectWorksheetHeaderRow(sheet, ['商品名称', '商品编号', '账面库存']);
    if (!headerRowNumber) {
        throw new ValidationError('无法识别库存状况表表头，请确认文件格式正确');
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
            code: trimText(record['商品编号']),
            name: trimText(record['商品名称']),
            spec: trimText(record['规格']),
            brand: trimText(record['品牌']),
            unit: normalizeMaterialUnit(trimText(record['基本单位']) || trimText(record['明细--单位']) || 'PCS', 'PCS'),
            categoryName: mapInventoryWorkbookCategory(record),
            costPrice: parseNumberField(record['成本均价'] ?? record['参考成本价'] ?? record['库存金额'], '成本均价'),
            salePrice: parseNumberField(record['零售价'] ?? record['预设售价1'], '零售价'),
            inventoryQty: parseNumberField(record['账面库存'] ?? record['仓内库存'], '账面库存'),
            raw: record
        });
    }

    return rows.filter(item => item.code || item.name);
}

function mapSupplierPricePlatform(value) {
    const text = trimText(value);
    if (!text) return 'offline';
    if (text.includes('淘宝')) return 'taobao';
    if (text.includes('1688')) return '1688';
    if (text.includes('京东')) return 'jd';
    if (text.includes('拼多多')) return 'pdd';
    if (text.includes('微信')) return 'wechat';
    if (text.includes('厂家') || text.includes('原厂')) return 'factory_direct';
    return 'offline';
}

async function parseSupplierPriceWorkbook(file) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ValidationError('Excel 中没有可用工作表');

    const headerRowNumber = detectWorksheetHeaderRow(sheet, ['往来单位名称', '商品编号', '商品名称', '最近采购折前价格']);
    if (!headerRowNumber) {
        throw new ValidationError('无法识别供应商价格本表头，请确认文件格式正确');
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

        const quotedPrice = parseNumberField(record['指定折前单价'], '指定折前单价');
        const quotedDiscount = parseNumberField(record['指定折扣(0.9为9折)'], '指定折扣');
        const lastPurchasePrice = parseNumberField(record['最近采购折前价格'], '最近采购折前价格');
        const lastPurchaseDiscount = parseNumberField(record['最近采购折扣'], '最近采购折扣');
        rows.push({
            rowNumber,
            supplierCode: trimText(record['往来单位编号']),
            supplierName: trimText(record['往来单位名称']),
            materialCode: trimText(record['商品编号']),
            materialName: trimText(record['商品名称']),
            unit: normalizeMaterialUnit(record['单位']),
            spec: trimText(record['规格']),
            model: trimText(record['型号']),
            quotedPrice,
            quotedDiscount: quotedDiscount == null ? 1 : quotedDiscount,
            effectivePrice: quotedPrice == null ? null : Number((quotedPrice * (quotedDiscount == null ? 1 : quotedDiscount)).toFixed(4)),
            lastPurchasePrice,
            lastPurchaseDiscount: lastPurchaseDiscount == null ? 1 : lastPurchaseDiscount,
            lastPurchaseEffectivePrice: lastPurchasePrice == null ? null : Number((lastPurchasePrice * (lastPurchaseDiscount == null ? 1 : lastPurchaseDiscount)).toFixed(4)),
            lastPurchaseAt: trimText(record['最近采购时间']),
            sourcePlatform: mapSupplierPricePlatform(record['往来单位名称']),
            raw: record
        });
    }

    return rows.filter(item => item.supplierName && (item.materialCode || item.materialName));
}

function getDefaultMaterialType(categoryId, fallback = 'raw') {
    if (!categoryId) return fallback;
    return fallback;
}

function getSupplyModeMeta(mode) {
    const map = {
        purchase_only: { label: '采购入库后领用', hint: '先采购收货入库，再按单据领用。' },
        direct_issue: { label: '库存现成件直接领用', hint: '现成库存件可直接发出，不需要前置工单。' },
        prebuild_wip: { label: '先做半成品再领用', hint: '应先通过前置工单完工入库，再由当前工单领用。' },
        on_site_fabrication: { label: '当前工单现场加工', hint: '仓库发出原材，车间在当前工单现场裁剪、焊接或装配。' }
    };
    return map[mode] || map.direct_issue;
}

function normalizeMaterialPayload(body, currentMaterial = null) {
    const stockPolicy = body.stockPolicy || {};
    const costPolicy = body.costPolicy || {};

    const materialType = trimText(body.materialType ?? body.material_type) || currentMaterial?.material_type || getDefaultMaterialType(body.categoryId ?? body.category_id);
    const lifecycleStatus = trimText(body.lifecycleStatus ?? body.lifecycle_status) || currentMaterial?.lifecycle_status || (currentMaterial?.is_active ? 'active' : 'draft');
    const supplyMode = trimText(body.supplyMode ?? body.supply_mode) || currentMaterial?.supply_mode || 'direct_issue';

    if (materialType && !MATERIAL_TYPES.includes(materialType)) {
        throw new ValidationError('无效的物料类型', 'materialType');
    }
    if (lifecycleStatus && !LIFECYCLE_STATUSES.includes(lifecycleStatus)) {
        throw new ValidationError('无效的生命周期状态', 'lifecycleStatus');
    }
    if (supplyMode && !SUPPLY_MODES.includes(supplyMode)) {
        throw new ValidationError('无效的供给方式', 'supplyMode');
    }

    const unit = normalizeMaterialUnit(body.baseUnit ?? body.unit, currentMaterial?.unit);
    const name = trimText(body.name) || currentMaterial?.name;
    if (!name) throw new ValidationError('请输入物料名称', 'name');
    if (!unit) throw new ValidationError('请输入单位', 'unit');

    const categoryId = body.categoryId !== undefined ? body.categoryId : body.category_id;
    const finalCategoryId = categoryId === undefined
        ? currentMaterial?.category_id
        : (categoryId === null || categoryId === '' ? null : Number(categoryId));

    const minStock = parseNumberField(body.minStock ?? body.min_stock ?? stockPolicy.minStock, 'minStock');
    const maxStock = parseNumberField(body.maxStock ?? body.max_stock ?? stockPolicy.maxStock, 'maxStock');
    const safetyStock = parseNumberField(body.safetyStock ?? body.safety_stock ?? stockPolicy.safetyStock ?? minStock, 'safetyStock');
    const reorderPoint = parseNumberField(body.reorderPoint ?? body.reorder_point ?? stockPolicy.reorderPoint ?? minStock, 'reorderPoint');
    const targetCoverageQty = parseNumberField(body.targetCoverageQty ?? body.target_coverage_qty ?? stockPolicy.targetCoverageQty, 'targetCoverageQty');
    const coverageDaysTarget = parseNumberField(body.coverageDaysTarget ?? body.coverage_days_target ?? stockPolicy.coverageDaysTarget, 'coverageDaysTarget');
    const economicOrderQty = parseNumberField(body.economicOrderQty ?? body.economic_order_qty ?? stockPolicy.economicOrderQty, 'economicOrderQty');
    const standardCost = parseNumberField(body.standardCost ?? body.standard_cost ?? costPolicy.standardCost ?? body.costPrice ?? body.cost_price, 'standardCost');
    const avgCost = parseNumberField(body.avgCost ?? body.avg_cost ?? costPolicy.avgCost ?? body.costPrice ?? body.cost_price, 'avgCost');
    const salePrice = parseNumberField(body.salePrice ?? body.sale_price ?? costPolicy.salePrice, 'salePrice');
    const costPrice = parseNumberField(body.costPrice ?? body.cost_price ?? standardCost, 'costPrice');

    const normalized = {
        code: trimText(body.code),
        internalCode: trimText(body.internalCode ?? body.internal_code ?? body.code),
        name,
        categoryId: finalCategoryId,
        unit,
        spec: trimText(body.spec),
        brand: trimText(body.brand),
        description: trimText(body.description),
        materialType,
        lifecycleStatus,
        supplyMode,
        minStock,
        maxStock,
        safetyStock,
        reorderPoint,
        targetCoverageQty,
        coverageDaysTarget,
        economicOrderQty,
        costPrice,
        standardCost,
        avgCost,
        salePrice,
        imageUrl: trimText(body.imageUrl ?? body.image_url),
        barcode: trimText(body.barcode),
        model: trimText(body.model),
        weight: parseNumberField(body.weight, 'weight'),
        dimensions: trimText(body.dimensions),
        supplier: trimText(body.supplier),
        supplierContact: trimText(body.supplierContact ?? body.supplier_contact),
        defaultWarehouseId: parseNumberField(body.defaultWarehouseId ?? body.default_warehouse_id, 'defaultWarehouseId'),
        defaultSupplierId: parseNumberField(body.defaultSupplierId ?? body.default_supplier_id, 'defaultSupplierId'),
        leadTimeDays: parseNumberField(body.leadTimeDays ?? body.lead_time_days, 'leadTimeDays'),
        minPurchaseQty: parseNumberField(body.minPurchaseQty ?? body.min_purchase_qty, 'minPurchaseQty'),
        purchaseLotSize: parseNumberField(body.purchaseLotSize ?? body.purchase_lot_size, 'purchaseLotSize'),
        taxRate: parseNumberField(body.taxRate ?? body.tax_rate, 'taxRate'),
        isSingleSource: parseBooleanFlag(body.isSingleSource ?? body.is_single_source),
        supplyRiskLevel: trimText(body.supplyRiskLevel ?? body.supply_risk_level),
        supplyRiskNotes: trimText(body.supplyRiskNotes ?? body.supply_risk_notes),
        allowNegativeStock: parseBooleanFlag(body.allowNegativeStock ?? body.allow_negative_stock ?? stockPolicy.allowNegativeStock),
        isBatchTracked: parseBooleanFlag(body.isBatchTracked ?? body.is_batch_tracked ?? stockPolicy.isBatchTracked),
        isSerialTracked: parseBooleanFlag(body.isSerialTracked ?? body.is_serial_tracked ?? stockPolicy.isSerialTracked),
        isExpiryTracked: parseBooleanFlag(body.isExpiryTracked ?? body.is_expiry_tracked ?? stockPolicy.isExpiryTracked),
        stockCountCycleDays: parseNumberField(body.stockCountCycleDays ?? body.stock_count_cycle_days, 'stockCountCycleDays'),
        isPurchasable: parseBooleanFlag(body.isPurchasable ?? body.is_purchasable),
        isProducible: parseBooleanFlag(body.isProducible ?? body.is_producible),
        isSellable: parseBooleanFlag(body.isSellable ?? body.is_sellable),
        defaultBomId: parseNumberField(body.defaultBomId ?? body.default_bom_id, 'defaultBomId'),
        defaultSopId: parseNumberField(body.defaultSopId ?? body.default_sop_id, 'defaultSopId'),
        yieldRate: parseNumberField(body.yieldRate ?? body.yield_rate, 'yieldRate'),
        scrapRate: parseNumberField(body.scrapRate ?? body.scrap_rate, 'scrapRate'),
        isKeyPart: parseBooleanFlag(body.isKeyPart ?? body.is_key_part),
        masterDataOwner: parseNumberField(body.masterDataOwner ?? body.master_data_owner, 'masterDataOwner'),
        dataQualityStatus: trimText(body.dataQualityStatus ?? body.data_quality_status),
        versionNo: parseNumberField(body.versionNo ?? body.version_no, 'versionNo'),
        notes: trimText(body.notes),
        uoms: Array.isArray(body.uoms) ? body.uoms : null,
        suppliers: Array.isArray(body.suppliers) ? body.suppliers : null,
        substitutions: Array.isArray(body.substitutions) ? body.substitutions : null
    };

    return normalized;
}

function getLastPurchaseReference(db, materialId) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stock_document_items'").get()) {
        return null;
    }

    const row = db.prepare(`
        SELECT sd.doc_no, sd.doc_type, sd.counterparty, sd.reference_no, sd.executed_at, sd.created_at,
               sdi.unit_price, sdi.total_price, sdi.quantity
        FROM stock_document_items sdi
        JOIN stock_documents sd ON sd.id = sdi.document_id
        WHERE sdi.material_id = ?
          AND sd.status = 'posted'
          AND sd.doc_type = 'receive_execution'
        ORDER BY COALESCE(sd.executed_at, sd.created_at) DESC, sd.id DESC
        LIMIT 1
    `).get(materialId);

    if (!row) return null;
    return {
        documentNo: row.doc_no,
        documentType: row.doc_type,
        counterparty: row.counterparty || null,
        referenceNo: row.reference_no || null,
        purchasedAt: row.executed_at || row.created_at || null,
        unitPrice: row.unit_price ?? null,
        totalPrice: row.total_price ?? null,
        quantity: row.quantity ?? null
    };
}

function getMaterialSupplyRisk(db, materialId) {
    const material = db.prepare(`
        SELECT id, is_single_source, lead_time_days, is_key_part, safety_stock, min_stock, reorder_point,
               supply_risk_level, supply_risk_notes
        FROM materials
        WHERE id = ?
    `).get(materialId);
    if (!material) return null;

    const currentStock = Number(db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) as qty
        FROM inventory
        WHERE material_id = ?
    `).get(materialId)?.qty || 0);

    const supplierRow = hasTable(db, 'material_suppliers')
        ? db.prepare(`
            SELECT COUNT(*) as supplier_count,
                   MAX(CASE WHEN is_default = 1 THEN lead_time_days END) as default_lead_time_days,
                   MAX(CASE WHEN is_default = 1 THEN source_platform END) as default_source_platform
            FROM material_suppliers
            WHERE material_id = ?
        `).get(materialId)
        : { supplier_count: 0, default_lead_time_days: 0, default_source_platform: null };

    const substitutionCount = hasTable(db, 'material_substitutions')
        ? Number(db.prepare(`
            SELECT COUNT(*) as cnt
            FROM material_substitutions
            WHERE material_id = ? AND COALESCE(is_active, 1) = 1
        `).get(materialId)?.cnt || 0)
        : 0;

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

    const riskLevel = score >= 90 ? 'critical' : score >= 60 ? 'high' : score >= 30 ? 'medium' : 'normal';
    return {
        riskScore: score,
        riskLevel: material.supply_risk_level || riskLevel,
        reasons,
        supplierCount,
        effectiveLeadTimeDays,
        hasSubstitution,
        avgDailyConsumption,
        coverageDays,
        safetyBufferDays,
        currentStock,
        warningThreshold,
        reorderPoint,
        sourcePlatform: supplierRow?.default_source_platform || null,
        riskNotes: material.supply_risk_notes || null,
        recommendedActions: [
            singleSource ? '优先核对唯一供应商交期' : null,
            !hasSubstitution ? '尽快维护替代料或替代工艺' : null,
            effectiveLeadTimeDays >= 7 ? '提前发起采购/备料' : null
        ].filter(Boolean)
    };
}

function replaceMaterialRelations(db, materialId, payload, userId) {
    if (payload.uoms) {
        const normalizedUoms = payload.uoms.map(item => ({
            uomType: trimText(item.uomType ?? item.uom_type),
            unitName: trimText(item.unitName ?? item.unit_name),
            ratioToBase: parseNumberField(item.ratioToBase ?? item.ratio_to_base, 'ratioToBase'),
            isDefault: parseBooleanFlag(item.isDefault ?? item.is_default) ?? 0
        }));

        if (!normalizedUoms.some(item => item.uomType === 'base' && item.isDefault === 1)) {
            throw new ValidationError('至少需要一个基础单位', 'uoms');
        }

        db.prepare('DELETE FROM material_uoms WHERE material_id = ?').run(materialId);
        const stmt = db.prepare(`
            INSERT INTO material_uoms (material_id, uom_type, unit_name, ratio_to_base, is_default)
            VALUES (?, ?, ?, ?, ?)
        `);
        normalizedUoms.forEach(item => {
            if (!item.uomType || !item.unitName || !item.ratioToBase) {
                throw new ValidationError('单位换算配置不完整', 'uoms');
            }
            stmt.run(materialId, item.uomType, item.unitName, item.ratioToBase, item.isDefault);
        });
    }

    if (payload.suppliers) {
        db.prepare('DELETE FROM material_suppliers WHERE material_id = ?').run(materialId);
        const stmt = db.prepare(`
            INSERT INTO material_suppliers (
                material_id, supplier_name, supplier_material_code, is_default,
                lead_time_days, min_order_qty, lot_size, last_purchase_price, notes,
                supplier_type, source_platform, shop_name, shop_url, purchase_url,
                contact_person, contact_phone, manufacturer_name, origin_region
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        payload.suppliers.forEach(item => {
            const supplierName = trimText(item.supplierName ?? item.supplier_name);
            if (!supplierName) return;
            const supplierType = trimText(item.supplierType ?? item.supplier_type) || 'distributor';
            const sourcePlatform = trimText(item.sourcePlatform ?? item.source_platform) || 'offline';
            if (!SUPPLIER_TYPES.includes(supplierType)) {
                throw new ValidationError(`无效的供应商类型: ${supplierType}`, 'suppliers');
            }
            if (!SOURCE_PLATFORMS.includes(sourcePlatform)) {
                throw new ValidationError(`无效的来源平台: ${sourcePlatform}`, 'suppliers');
            }
            stmt.run(
                materialId,
                supplierName,
                trimText(item.supplierMaterialCode ?? item.supplier_material_code),
                parseBooleanFlag(item.isDefault ?? item.is_default) ?? 0,
                parseNumberField(item.leadTimeDays ?? item.lead_time_days, 'leadTimeDays') ?? 0,
                parseNumberField(item.minOrderQty ?? item.min_order_qty, 'minOrderQty') ?? 0,
                parseNumberField(item.lotSize ?? item.lot_size, 'lotSize') ?? 0,
                parseNumberField(item.lastPurchasePrice ?? item.last_purchase_price, 'lastPurchasePrice') ?? 0,
                trimText(item.notes),
                supplierType,
                sourcePlatform,
                trimText(item.shopName ?? item.shop_name),
                trimText(item.shopUrl ?? item.shop_url),
                trimText(item.purchaseUrl ?? item.purchase_url),
                trimText(item.contactPerson ?? item.contact_person),
                trimText(item.contactPhone ?? item.contact_phone),
                trimText(item.manufacturerName ?? item.manufacturer_name),
                trimText(item.originRegion ?? item.origin_region)
            );
        });
    }

    if (payload.substitutions) {
        db.prepare('DELETE FROM material_substitutions WHERE material_id = ?').run(materialId);
        const stmt = db.prepare(`
            INSERT INTO material_substitutions (
                material_id, substitute_material_id, priority, substitution_type, reason, is_active, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        payload.substitutions.forEach(item => {
            const substituteMaterialId = parseNumberField(item.substituteMaterialId ?? item.substitute_material_id, 'substituteMaterialId');
            if (!substituteMaterialId) return;
            stmt.run(
                materialId,
                substituteMaterialId,
                parseNumberField(item.priority, 'priority') ?? 1,
                trimText(item.substitutionType ?? item.substitution_type) || 'full',
                trimText(item.reason),
                parseBooleanFlag(item.isActive ?? item.is_active) ?? 1,
                userId
            );
        });
    }
}

function getLifecycleTransitionTargets(fromStatus) {
    return {
        draft: ['pending_review'],
        pending_review: ['draft', 'active'],
        active: ['frozen', 'inactive'],
        frozen: ['active', 'inactive'],
        inactive: ['obsolete'],
        obsolete: []
    }[fromStatus] || [];
}

function getMaterialUsageDetails(db, materialId) {
    const directBoms = db.prepare(`
        SELECT DISTINCT b.id, b.code, b.name, b.version, b.status,
               bi.quantity, bi.position, bi.loss_rate,
               'direct' as usage_type
        FROM bom_items bi
        JOIN boms b ON b.id = bi.bom_id
        WHERE bi.material_id = ?
        ORDER BY b.updated_at DESC
        LIMIT 100
    `).all(materialId);

    const indirectBoms = [];
    const seenBomIds = new Set(directBoms.map(item => Number(item.id)));

    function collectParentBoms(bomIds, depth = 1) {
        if (!bomIds.length || depth > 10) return;
        const placeholders = bomIds.map(() => '?').join(',');
        const parentRows = db.prepare(`
            SELECT DISTINCT b.id, b.code, b.name, b.version, b.status,
                   bi.position, bi.loss_rate, bi.sub_bom_id
            FROM bom_items bi
            JOIN boms b ON b.id = bi.bom_id
            WHERE bi.sub_bom_id IN (${placeholders})
            ORDER BY b.updated_at DESC
        `).all(...bomIds);

        const nextBomIds = [];
        for (const row of parentRows) {
            const bomId = Number(row.id);
            if (seenBomIds.has(bomId)) continue;
            seenBomIds.add(bomId);
            indirectBoms.push({
                id: row.id,
                code: row.code,
                name: row.name,
                version: row.version,
                status: row.status,
                quantity: null,
                position: row.position,
                loss_rate: row.loss_rate,
                via_bom_id: row.sub_bom_id,
                depth,
                usage_type: 'indirect'
            });
            nextBomIds.push(bomId);
        }

        if (nextBomIds.length) collectParentBoms(nextBomIds, depth + 1);
    }

    collectParentBoms(directBoms.map(item => Number(item.id)));

    return {
        boms: [...directBoms, ...indirectBoms],
        directBoms,
        indirectBoms,
        bomUsageTotal: directBoms.length + indirectBoms.length,
        sops: db.prepare(`
            SELECT DISTINCT s.id, s.title, s.version, s.is_active
            FROM sop_materials sm
            JOIN sops s ON s.id = sm.sop_id
            WHERE sm.material_id = ?
            ORDER BY s.updated_at DESC
            LIMIT 50
        `).all(materialId),
        shipments: db.prepare(`
            SELECT DISTINCT s.id, s.shipment_no, s.status, s.created_at
            FROM shipment_items si
            JOIN shipments s ON s.id = si.shipment_id
            WHERE si.material_id = ?
            ORDER BY s.created_at DESC
            LIMIT 50
        `).all(materialId),
        productionOrders: db.prepare(`
            SELECT id, order_no, status, planned_quantity, completed_quantity, created_at
            FROM production_orders
            WHERE output_material_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `).all(materialId),
        inventoryRows: db.prepare(`
            SELECT i.id, i.warehouse_id, w.name as warehouse_name, i.quantity, i.updated_at
            FROM inventory i
            JOIN warehouses w ON w.id = i.warehouse_id
            WHERE i.material_id = ?
            ORDER BY w.name ASC
        `).all(materialId)
    };
}

function getMaterialMergeDetails(db, materialId) {
    return {
        mergedSources: db.prepare(`
            SELECT mml.id, mml.source_material_id, mml.target_material_id, mml.reason, mml.changed_at,
                   src.code as source_code, src.name as source_name
            FROM material_merge_logs mml
            JOIN materials src ON src.id = mml.source_material_id
            WHERE mml.target_material_id = ?
            ORDER BY mml.changed_at DESC, mml.id DESC
            LIMIT 20
        `).all(materialId),
        mergedInto: db.prepare(`
            SELECT mml.id, mml.source_material_id, mml.target_material_id, mml.reason, mml.changed_at,
                   tgt.code as target_code, tgt.name as target_name
            FROM material_merge_logs mml
            JOIN materials tgt ON tgt.id = mml.target_material_id
            WHERE mml.source_material_id = ?
            ORDER BY mml.changed_at DESC, mml.id DESC
            LIMIT 1
        `).get(materialId) || null
    };
}

function cleanupExpiredPreviews() {
    const now = Date.now();
    for (const [token, entry] of importPreviewStore.entries()) {
        if (entry.expiresAt <= now) {
            importPreviewStore.delete(token);
        }
    }
}

function buildImportPreviewToken() {
    return `imp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

function parseCsvRecords(content) {
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]).map(item => item.trim());
    return lines.slice(1).map(line => {
        const values = parseCsvLine(line);
        const record = {};
        headers.forEach((header, index) => {
            record[header] = (values[index] || '').trim();
        });
        return record;
    }).filter(record => Object.values(record).some(Boolean));
}

async function parseImportFile(file) {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (ext === 'csv') {
        return parseCsvRecords(file.buffer.toString('utf-8'));
    }
    if (ext === 'json') {
        const parsed = JSON.parse(file.buffer.toString('utf-8'));
        if (!Array.isArray(parsed)) throw new ValidationError('JSON 必须是数组');
        return parsed;
    }
    if (ext === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(file.buffer);
        const sheet = workbook.worksheets[0];
        if (!sheet || sheet.rowCount < 2) return [];
        const headers = [];
        sheet.getRow(1).eachCell((cell, colNumber) => {
            headers[colNumber] = String(cell.value || '').trim();
        });
        const rows = [];
        for (let i = 2; i <= sheet.rowCount; i++) {
            const row = sheet.getRow(i);
            const record = {};
            let hasValue = false;
            headers.forEach((header, colNumber) => {
                if (!header) return;
                let value = row.getCell(colNumber).value;
                if (value && typeof value === 'object' && value.result !== undefined) value = value.result;
                if (value && typeof value === 'object' && value.text) value = value.text;
                record[header] = value ?? '';
                if (value !== null && value !== undefined && value !== '') hasValue = true;
            });
            if (hasValue) rows.push(record);
        }
        return rows;
    }
    throw new ValidationError('仅支持 .csv / .xlsx / .json 文件');
}

function looksLikeInventoryWorkbookFile(file, records = []) {
    const fileName = String(file?.originalname || '').toLowerCase();
    if (fileName.includes('库存状况表') || fileName.includes('商品库存')) {
        return true;
    }
    const firstRow = records.find(item => item && typeof item === 'object') || {};
    const keys = Object.keys(firstRow);
    return ['商品名称', '商品编号', '账面库存'].every(key => keys.includes(key));
}

async function detectInventoryWorkbookUpload(file) {
    const ext = (file?.originalname?.split('.').pop() || '').toLowerCase();
    if (looksLikeInventoryWorkbookFile(file)) return true;
    if (ext !== 'xlsx' || !file?.buffer) return false;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return false;
    return detectWorksheetHeaderRow(sheet, ['商品名称', '商品编号', '账面库存']) > 0;
}

function normalizeImportRecord(row) {
    const name = trimText(getImportField(row, ['name', '名称', '名称（必填）']));
    const code = trimText(getImportField(row, ['code', '编码', '编码（留空自动生成）']));
    const unit = normalizeMaterialUnit(getImportField(row, ['unit', '单位', '单位（必填）']));
    const categoryName = trimText(getImportField(row, ['category', '分类', '分类名称']));
    const spec = trimText(getImportField(row, ['spec', '规格']));
    const brand = trimText(getImportField(row, ['brand', '品牌']));
    const rawCostPrice = getImportField(row, ['cost_price', '成本价']);
    const rawSalePrice = getImportField(row, ['sale_price', '售价']);
    const rawMinStock = getImportField(row, ['min_stock', '最低库存']);
    const rawSafetyStock = getImportField(row, ['safety_stock', '安全库存']);
    const rawReorderPoint = getImportField(row, ['reorder_point', '补货点']);
    const rawTargetCoverageQty = getImportField(row, ['target_coverage_qty', '目标保供套数', '保供套数']);
    const supplier = trimText(getImportField(row, ['supplier', '供应商']));
    const notes = trimText(getImportField(row, ['notes', '备注']));
    const materialType = trimText(getImportField(row, ['materialType', '物料类型']));
    const lifecycleStatus = trimText(getImportField(row, ['lifecycleStatus', '生命周期']));
    const rawPurchasable = getImportField(row, ['isPurchasable', '可采购']);
    const rawProducible = getImportField(row, ['isProducible', '可生产']);
    const rawSellable = getImportField(row, ['isSellable', '可销售']);
    const rawKeyPart = getImportField(row, ['isKeyPart', '关键件']);
    const minStock = rawMinStock === undefined ? undefined : (parseNumberField(rawMinStock, 'min_stock') ?? 0);
    const safetyStock = rawSafetyStock === undefined ? undefined : (parseNumberField(rawSafetyStock, 'safety_stock') ?? minStock ?? 0);
    const reorderPoint = rawReorderPoint === undefined ? undefined : (parseNumberField(rawReorderPoint, 'reorder_point') ?? minStock ?? 0);

    return {
        code,
        name,
        unit,
        categoryName,
        spec,
        brand,
        costPrice: rawCostPrice === undefined ? undefined : (parseNumberField(rawCostPrice, 'cost_price') ?? 0),
        salePrice: rawSalePrice === undefined ? undefined : (parseNumberField(rawSalePrice, 'sale_price') ?? 0),
        minStock,
        safetyStock,
        reorderPoint,
        targetCoverageQty: rawTargetCoverageQty === undefined ? undefined : (parseNumberField(rawTargetCoverageQty, 'target_coverage_qty') ?? 0),
        supplier,
        notes,
        materialType,
        lifecycleStatus,
        isPurchasable: rawPurchasable === undefined ? undefined : (parseBooleanFlag(rawPurchasable) ?? 0),
        isProducible: rawProducible === undefined ? undefined : (parseBooleanFlag(rawProducible) ?? 0),
        isSellable: rawSellable === undefined ? undefined : (parseBooleanFlag(rawSellable) ?? 0),
        isKeyPart: rawKeyPart === undefined ? undefined : (parseBooleanFlag(rawKeyPart) ?? 0)
    };
}

/**
 * GET /api/materials
 * 物料列表 - 支持搜索、分页、分类筛选
 *
 * Query params:
 *   q          - 搜索关键词（支持中文、全拼、简拼、编码）
 *   category   - 分类ID筛选
 *   active     - 1=仅启用 0=仅禁用（默认1）
 *   page       - 页码（默认1）
 *   limit      - 每页条数（默认20，最大100）
 *   sort       - 排序字段（默认 updated_at）
 *   order      - asc/desc（默认 desc）
 */
router.get('/', requirePermission('materials', 'view'), (req, res) => {
    const db = getDB();
    const {
        q = '',
        category = '',
        categoryId = '',
        active = '1',
        page = '1',
        limit = '20',
        sort = 'updated_at',
        order = 'desc',
        materialType = '',
        lifecycleStatus = '',
        isPurchasable = '',
        isProducible = '',
        isSellable = '',
        lowStockOnly = '',
        negativeStockOnly = '',
        dirtyOnly = ''
    } = req.query;

    // 分页参数
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageSize;

    // 排序验证
    const allowedSorts = ['id', 'code', 'name', 'category_id', 'cost_price', 'sale_price', 'created_at', 'updated_at', 'material_type', 'lifecycle_status', 'total_stock'];
    const sortField = allowedSorts.includes(sort) ? sort : 'updated_at';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // 构建查询条件
    const conditions = [];
    const params = [];

    // 搜索条件（拼音 + 名称 + 编码，加 m. 前缀避免 JOIN 歧义）
    if (q.trim()) {
        const search = buildSearchCondition(q, {
            nameField: 'm.name',
            pinyinField: 'm.name_pinyin',
            abbrField: 'm.name_pinyin_abbr',
            codeField: 'm.code'
        });
        conditions.push(search.where);
        params.push(...search.params);
    }

    // 分类筛选
    const finalCategory = categoryId || category;
    if (finalCategory) {
        conditions.push('m.category_id = ?');
        params.push(parseInt(finalCategory, 10));
    }

    // 启用/禁用筛选
    if (active !== '') {
        conditions.push('m.is_active = ?');
        params.push(parseInt(active, 10));
    }

    if (materialType) {
        conditions.push('m.material_type = ?');
        params.push(materialType);
    }

    if (lifecycleStatus) {
        conditions.push('m.lifecycle_status = ?');
        params.push(lifecycleStatus);
    }

    if (req.query.supplyMode) {
        conditions.push('m.supply_mode = ?');
        params.push(req.query.supplyMode);
    }

    const purchasableFlag = parseBooleanFlag(isPurchasable);
    if (purchasableFlag !== null) {
        conditions.push('m.is_purchasable = ?');
        params.push(purchasableFlag);
    }

    const producibleFlag = parseBooleanFlag(isProducible);
    if (producibleFlag !== null) {
        conditions.push('m.is_producible = ?');
        params.push(producibleFlag);
    }

    const sellableFlag = parseBooleanFlag(isSellable);
    if (sellableFlag !== null) {
        conditions.push('m.is_sellable = ?');
        params.push(sellableFlag);
    }

    const lowStockFlag = parseBooleanFlag(lowStockOnly);
    if (lowStockFlag === 1) {
        conditions.push('COALESCE(inv.total_stock, 0) <= COALESCE(NULLIF(m.safety_stock, 0), m.min_stock, 0)');
    }

    const negativeStockFlag = parseBooleanFlag(negativeStockOnly);
    if (negativeStockFlag === 1) {
        conditions.push('COALESCE(inv.total_stock, 0) < 0');
    }

    const dirtyFlag = parseBooleanFlag(dirtyOnly);
    if (dirtyFlag === 1) {
        conditions.push("m.data_quality_status != 'normal'");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const baseFromClause = `
        FROM materials m
        LEFT JOIN categories c ON m.category_id = c.id
        LEFT JOIN (
            SELECT material_id, COALESCE(SUM(quantity), 0) as total_stock
            FROM inventory
            GROUP BY material_id
        ) inv ON inv.material_id = m.id
        LEFT JOIN (
            SELECT ms1.material_id, ms1.supplier_name, ms1.source_platform
            FROM material_suppliers ms1
            INNER JOIN (
                SELECT material_id, MIN(CASE WHEN is_default = 1 THEN 0 ELSE 1 END) as sort_rank
                FROM material_suppliers
                GROUP BY material_id
            ) picked ON picked.material_id = ms1.material_id
                     AND (CASE WHEN ms1.is_default = 1 THEN 0 ELSE 1 END) = picked.sort_rank
            WHERE ms1.id = (
                SELECT ms2.id
                FROM material_suppliers ms2
                WHERE ms2.material_id = ms1.material_id
                  AND (CASE WHEN ms2.is_default = 1 THEN 0 ELSE 1 END) = picked.sort_rank
                ORDER BY ms2.id ASC
                LIMIT 1
            )
        ) supplier_ref ON supplier_ref.material_id = m.id
    `;

    // 查询总数
    const countRow = db.prepare(
        `SELECT COUNT(*) as total ${baseFromClause} ${whereClause}`
    ).get(...params);

    const orderSql = sortField === 'total_stock' ? `COALESCE(inv.total_stock, 0) ${sortOrder}` : `m.${sortField} ${sortOrder}`;

    const materials = db.prepare(`
        SELECT m.*, c.name as category_name, COALESCE(inv.total_stock, 0) as total_stock,
               supplier_ref.supplier_name as default_supplier_name,
               supplier_ref.source_platform as default_supplier_platform
        ${baseFromClause}
        ${whereClause}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    const enrichedMaterials = materials.map(m => ({
        ...m,
        total_stock: m.total_stock || 0,
        is_low_stock: (m.total_stock || 0) <= (m.safety_stock || m.min_stock || 0),
        is_negative_stock: (m.total_stock || 0) < 0
    }));

    res.json({
        success: true,
        data: {
            materials: enrichedMaterials,
            pagination: {
                page: pageNum,
                limit: pageSize,
                total: countRow.total,
                totalPages: Math.ceil(countRow.total / pageSize)
            }
        }
    });
});

router.get('/duplicates', requirePermission('materials', 'view'), (req, res) => {
    const db = getDB();
    const { rule = 'same_spec_key', page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageSize;

    let duplicateGroups = [];
    if (rule === 'same_name_spec_brand_unit') {
        duplicateGroups = db.prepare(`
            SELECT lower(trim(COALESCE(name, '') || '|' || COALESCE(spec, '') || '|' || COALESCE(brand, '') || '|' || COALESCE(unit, ''))) as group_key,
                   COUNT(*) as item_count
            FROM materials
            WHERE is_active = 1
            GROUP BY group_key
            HAVING item_count > 1 AND group_key != '|||'
            ORDER BY item_count DESC, group_key ASC
            LIMIT ? OFFSET ?
        `).all(pageSize, offset);
    } else {
        duplicateGroups = db.prepare(`
            SELECT spec_key as group_key, COUNT(*) as item_count
            FROM materials
            WHERE is_active = 1 AND COALESCE(spec_key, '') != ''
            GROUP BY spec_key
            HAVING item_count > 1
            ORDER BY item_count DESC, spec_key ASC
            LIMIT ? OFFSET ?
        `).all(pageSize, offset);
    }

    const groups = duplicateGroups.map(group => ({
        rule,
        groupKey: group.group_key,
        itemCount: group.item_count,
        items: db.prepare(`
            SELECT id, code, internal_code, name, spec, brand, unit, material_type, lifecycle_status, data_quality_status, updated_at
            FROM materials
            WHERE ${rule === 'same_name_spec_brand_unit'
                ? "lower(trim(COALESCE(name, '') || '|' || COALESCE(spec, '') || '|' || COALESCE(brand, '') || '|' || COALESCE(unit, ''))) = ?"
                : 'spec_key = ?'}
            ORDER BY updated_at DESC, id DESC
        `).all(group.group_key)
    }));

    const total = db.prepare(`
        SELECT COUNT(*) as cnt FROM (
            SELECT 1
            FROM materials
            WHERE is_active = 1 AND ${
                rule === 'same_name_spec_brand_unit'
                    ? "lower(trim(COALESCE(name, '') || '|' || COALESCE(spec, '') || '|' || COALESCE(brand, '') || '|' || COALESCE(unit, ''))) != '|||'"
                    : "COALESCE(spec_key, '') != ''"
            }
            GROUP BY ${
                rule === 'same_name_spec_brand_unit'
                    ? "lower(trim(COALESCE(name, '') || '|' || COALESCE(spec, '') || '|' || COALESCE(brand, '') || '|' || COALESCE(unit, '')))"
                    : 'spec_key'
            }
            HAVING COUNT(*) > 1
        )
    `).get().cnt;

    res.json({
        success: true,
        data: {
            groups,
            pagination: {
                page: pageNum,
                limit: pageSize,
                total,
                totalPages: Math.ceil(total / pageSize)
            }
        }
    });
});

router.get('/naming-governance/summary', requirePermission('materials', 'view'), (req, res) => {
    const db = getDB();
    const { q = '', namingStatus = '', materialType = '' } = req.query;
    const params = [];
    const whereClauses = ['m.is_active = 1'];

    if (materialType) {
        whereClauses.push('m.material_type = ?');
        params.push(materialType);
    }
    if (q) {
        const search = buildSearchCondition(q, {
            nameField: 'm.name',
            pinyinField: 'm.name_pinyin',
            abbrField: 'm.name_pinyin_abbr',
            codeField: 'm.code'
        });
        whereClauses.push(`(${search.where} OR COALESCE(m.spec, '') LIKE ? OR COALESCE(m.brand, '') LIKE ?)`);
        params.push(...search.params, `%${q}%`, `%${q}%`);
    }

    const items = db.prepare(`
        SELECT m.id, m.code, m.name, m.spec, m.brand, m.unit, m.material_type, m.lifecycle_status, m.updated_at
        FROM materials m
        ${whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY m.updated_at DESC, m.id DESC
    `).all(...params).map(item => {
        const review = evaluateMaterialNaming(item);
        return {
            ...item,
            naming_status: review.namingStatus,
            naming_issues: review.namingIssues,
            suggested_name: review.suggestedName
        };
    });

    const filteredItems = namingStatus ? items.filter(item => item.naming_status === namingStatus) : items;

    res.json({
        success: true,
        data: {
            summary: {
                total: filteredItems.length,
                compliant: filteredItems.filter(item => item.naming_status === 'compliant').length,
                warning: filteredItems.filter(item => item.naming_status === 'warning').length,
                nonCompliant: filteredItems.filter(item => item.naming_status === 'non_compliant').length
            },
            items: filteredItems
        }
    });
});

router.get('/search-options', (req, res) => {
    const db = getDB();
    const q = trimText(req.query.q) || '';
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));

    const params = [];
    const clauses = ["m.lifecycle_status != 'obsolete'"];
    if (q) {
        const search = buildSearchCondition(q, {
            nameField: 'm.name',
            pinyinField: 'm.name_pinyin',
            abbrField: 'm.name_pinyin_abbr',
            codeField: 'm.code'
        });
        clauses.push(`(${search.where} OR m.spec LIKE ? OR m.brand LIKE ?)`);
        params.push(...search.params, `%${q}%`, `%${q}%`);
    }

    const items = db.prepare(`
        SELECT m.id, m.code, m.name, m.spec, m.brand, m.unit, m.material_type, m.lifecycle_status, m.supply_mode,
               m.sale_price, m.cost_price, m.min_stock, m.safety_stock,
               COALESCE(inv.total_stock, 0) as total_stock
        FROM materials m
        LEFT JOIN (
            SELECT material_id, COALESCE(SUM(quantity), 0) as total_stock
            FROM inventory
            GROUP BY material_id
        ) inv ON inv.material_id = m.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY
            CASE WHEN ? != '' AND m.code = ? THEN 0 ELSE 1 END,
            CASE WHEN ? != '' AND m.name = ? THEN 0 ELSE 1 END,
            m.updated_at DESC,
            m.id DESC
        LIMIT ?
    `).all(...params, q, q, q, q, limit).map(item => ({
        ...item,
        warning_status: Number(item.total_stock || 0) < 0
            ? 'negative'
            : (Number(item.total_stock || 0) <= Number(item.safety_stock || item.min_stock || 0) ? 'low' : 'normal'),
        supply_mode_label: getSupplyModeMeta(item.supply_mode).label,
        supply_mode_hint: getSupplyModeMeta(item.supply_mode).hint
    }));

    res.json({ success: true, data: { items } });
});

router.post('/import/preview', requirePermission('materials', 'add'), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) throw new ValidationError('请选择导入文件');
        cleanupExpiredPreviews();

        const db = getDB();
        const isInventoryWorkbook = await detectInventoryWorkbookUpload(req.file);
        const records = await parseImportFile(req.file);
        if (!records.length) throw new ValidationError('文件中没有有效数据');
        if (isInventoryWorkbook || looksLikeInventoryWorkbookFile(req.file, records)) {
            throw new ValidationError('当前文件属于“库存状况表”导入场景，请切换到“库存状况表”标签后再校验。');
        }
        if (records.length > 500) throw new ValidationError('单次导入最多支持500条');

        const categoryMap = {};
        db.prepare('SELECT id, name FROM categories').all().forEach(item => {
            categoryMap[item.name] = item.id;
        });

        const items = [];
        const summary = { total: records.length, creatable: 0, updatable: 0, duplicated: 0, invalid: 0 };
        const seenCodes = new Set();

        records.forEach((row, index) => {
            const normalized = normalizeImportRecord(row);
            const existing = normalized.code
                ? db.prepare('SELECT id, code, name FROM materials WHERE code = ?').get(normalized.code)
                : null;
            const previewItem = {
                row: index + 2,
                action: existing ? 'update' : 'create',
                code: normalized.code,
                name: normalized.name,
                normalized,
                warnings: [],
                errors: []
            };

            if (!existing && !normalized.name) previewItem.errors.push('名称不能为空');
            if (!existing && !normalized.unit) previewItem.errors.push('单位不能为空');
            if (normalized.materialType && !MATERIAL_TYPES.includes(normalized.materialType)) previewItem.errors.push('物料类型无效');
            if (normalized.lifecycleStatus && !LIFECYCLE_STATUSES.includes(normalized.lifecycleStatus)) previewItem.errors.push('生命周期无效');
            if (normalized.code && seenCodes.has(normalized.code)) previewItem.errors.push(`文件内编码重复: ${normalized.code}`);
            if (normalized.code) seenCodes.add(normalized.code);

            if (normalized.categoryName && !categoryMap[normalized.categoryName]) {
                previewItem.warnings.push(`分类 "${normalized.categoryName}" 不存在，提交时将自动创建`);
            }

            if (previewItem.errors.length > 0) {
                previewItem.action = 'invalid';
                summary.invalid++;
                items.push(previewItem);
                return;
            }

            if (existing) {
                previewItem.materialId = existing.id;
                summary.updatable++;
            } else if (normalized.code) {
                summary.creatable++;
            } else {
                previewItem.action = 'create';
                previewItem.warnings.push('编码为空，提交时将自动生成');
                summary.creatable++;
            }

            items.push(previewItem);
        });

        summary.duplicated = items.filter(item => item.errors.some(msg => msg.includes('重复'))).length;

        const previewToken = buildImportPreviewToken();
        importPreviewStore.set(previewToken, {
            createdBy: req.session.user.id,
            createdAt: Date.now(),
            expiresAt: Date.now() + 30 * 60 * 1000,
            items,
            summary
        });

        res.json({ success: true, data: { previewToken, summary, items } });
    } catch (error) {
        next(error);
    }
});

router.post('/import/commit', requirePermission('materials', 'add'), (req, res) => {
    cleanupExpiredPreviews();
    const { previewToken, mode = 'all_or_nothing' } = req.body;
    if (!previewToken) throw new ValidationError('缺少 previewToken');
    const preview = importPreviewStore.get(previewToken);
    if (!preview || preview.createdBy !== req.session.user.id) {
        throw new ValidationError('导入预览已失效，请重新上传文件');
    }
    if (mode !== 'all_or_nothing') throw new ValidationError('当前仅支持 all_or_nothing 模式');

    const invalidItems = preview.items.filter(item => item.action === 'invalid');
    if (invalidItems.length > 0) {
        throw new ValidationError(`存在 ${invalidItems.length} 条无效数据，无法提交`);
    }

    const db = getDB();
    const categoryCache = {};
    db.prepare('SELECT id, name FROM categories').all().forEach(item => {
        categoryCache[item.name] = item.id;
    });

    const doCommit = db.transaction(() => {
        let imported = 0;
        let updated = 0;
        preview.items.forEach(item => {
            const row = item.normalized;
            let categoryId = null;
            if (row.categoryName) {
                if (categoryCache[row.categoryName]) {
                    categoryId = categoryCache[row.categoryName];
                } else {
                    const { fullPinyin, abbr } = generatePinyinFields(row.categoryName);
                    const result = db.prepare(`
                        INSERT INTO categories (name, name_pinyin, name_pinyin_abbr)
                        VALUES (?, ?, ?)
                    `).run(row.categoryName, fullPinyin, abbr);
                    categoryId = result.lastInsertRowid;
                    categoryCache[row.categoryName] = categoryId;
                }
            }

            if (item.action === 'update') {
                const current = db.prepare('SELECT * FROM materials WHERE id = ?').get(item.materialId);
                const nextLifecycleStatus = row.lifecycleStatus || current.lifecycle_status;
                const nextUnit = row.unit || current.unit;
                const nextName = row.name || current.name;
                db.prepare(`
                    UPDATE materials SET
                        name = ?, category_id = ?, unit = ?, spec = ?, brand = ?,
                        cost_price = ?, standard_cost = ?, avg_cost = ?, sale_price = ?,
                        min_stock = ?, safety_stock = ?, reorder_point = ?, target_coverage_qty = ?,
                        supplier = ?, notes = ?, material_type = ?, lifecycle_status = ?,
                        is_purchasable = ?, is_producible = ?, is_sellable = ?, is_key_part = ?,
                        is_active = CASE WHEN ? IN ('inactive', 'obsolete') THEN 0 ELSE is_active END,
                        activated_at = CASE
                            WHEN lifecycle_status != 'active' AND ? = 'active' THEN datetime('now', 'localtime')
                            ELSE activated_at
                        END,
                        obsolete_at = CASE
                            WHEN ? = 'obsolete' THEN datetime('now', 'localtime')
                            WHEN lifecycle_status = 'obsolete' AND ? != 'obsolete' THEN NULL
                            ELSE obsolete_at
                        END,
                        spec_key = ?, version_no = version_no + 1, updated_at = datetime('now', 'localtime')
                    WHERE id = ?
                `).run(
                    nextName,
                    row.categoryName === undefined ? current.category_id : categoryId,
                    nextUnit,
                    row.spec !== undefined ? row.spec : current.spec,
                    row.brand !== undefined ? row.brand : current.brand,
                    row.costPrice !== undefined ? row.costPrice : current.cost_price,
                    row.costPrice !== undefined ? row.costPrice : current.standard_cost,
                    row.costPrice !== undefined ? row.costPrice : current.avg_cost,
                    row.salePrice !== undefined ? row.salePrice : current.sale_price,
                    row.minStock !== undefined ? row.minStock : current.min_stock,
                    row.safetyStock !== undefined ? row.safetyStock : current.safety_stock,
                    row.reorderPoint !== undefined ? row.reorderPoint : current.reorder_point,
                    row.targetCoverageQty !== undefined ? row.targetCoverageQty : current.target_coverage_qty,
                    row.supplier !== undefined ? row.supplier : current.supplier,
                    row.notes !== undefined ? row.notes : current.notes,
                    row.materialType || current.material_type,
                    nextLifecycleStatus,
                    row.isPurchasable !== undefined ? row.isPurchasable : current.is_purchasable,
                    row.isProducible !== undefined ? row.isProducible : current.is_producible,
                    row.isSellable !== undefined ? row.isSellable : current.is_sellable,
                    row.isKeyPart !== undefined ? row.isKeyPart : current.is_key_part,
                    nextLifecycleStatus,
                    nextLifecycleStatus,
                    nextLifecycleStatus,
                    nextLifecycleStatus,
                    buildSpecKey(
                        nextName,
                        row.spec !== undefined ? row.spec : current.spec,
                        row.brand !== undefined ? row.brand : current.brand,
                        nextUnit
                    ),
                    item.materialId
                );
                if (!db.prepare('SELECT 1 FROM material_uoms WHERE material_id = ? AND uom_type = ? AND is_default = 1').get(item.materialId, 'base')) {
                    db.prepare(`
                        INSERT INTO material_uoms (material_id, uom_type, unit_name, ratio_to_base, is_default)
                        VALUES (?, 'base', ?, 1, 1)
                    `).run(item.materialId, nextUnit);
                }
                if (nextLifecycleStatus !== current.lifecycle_status) {
                    db.prepare(`
                        INSERT INTO material_lifecycle_logs (material_id, from_status, to_status, reason, changed_by)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(item.materialId, current.lifecycle_status, nextLifecycleStatus, '导入更新', req.session.user.id);
                }
                updated++;
            } else {
                const materialCode = row.code || generateMaterialCode(db);
                const materialType = row.materialType || 'raw';
                const lifecycleStatus = row.lifecycleStatus || 'active';
                const unit = row.unit || 'PCS';
                const name = row.name;
                const { fullPinyin, abbr } = generatePinyinFields(row.name);
                const result = db.prepare(`
                    INSERT INTO materials (
                        code, internal_code, name, name_pinyin, name_pinyin_abbr, category_id, unit, spec, brand,
                        min_stock, safety_stock, reorder_point, target_coverage_qty, cost_price, standard_cost, avg_cost, sale_price,
                        supplier, notes, material_type, lifecycle_status,
                        is_purchasable, is_producible, is_sellable, is_key_part,
                        spec_key, is_active, created_by, created_at, updated_at, activated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'), ?)
                `).run(
                    materialCode, materialCode, name, fullPinyin, abbr, categoryId, unit, row.spec, row.brand,
                    row.minStock ?? 0, row.safetyStock ?? row.minStock ?? 0, row.reorderPoint ?? row.minStock ?? 0, row.targetCoverageQty ?? 0, row.costPrice ?? 0, row.costPrice ?? 0, row.costPrice ?? 0, row.salePrice ?? 0,
                    row.supplier, row.notes, materialType, lifecycleStatus,
                    row.isPurchasable ?? 0, row.isProducible ?? 0, row.isSellable ?? 0, row.isKeyPart ?? 0,
                    buildSpecKey(name, row.spec, row.brand, unit),
                    lifecycleStatus === 'inactive' || lifecycleStatus === 'obsolete' ? 0 : 1,
                    req.session.user.id,
                    lifecycleStatus === 'active' ? new Date().toISOString() : null
                );
                db.prepare(`
                    INSERT INTO material_uoms (material_id, uom_type, unit_name, ratio_to_base, is_default)
                    VALUES (?, 'base', ?, 1, 1)
                `).run(result.lastInsertRowid, unit);
                if (lifecycleStatus !== 'draft') {
                    db.prepare(`
                        INSERT INTO material_lifecycle_logs (material_id, from_status, to_status, reason, changed_by)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(result.lastInsertRowid, 'draft', lifecycleStatus, '导入创建', req.session.user.id);
                }
                imported++;
            }
        });
        return { imported, updated, failed: 0, total: preview.items.length };
    });

    const result = doCommit();
    importPreviewStore.delete(previewToken);

    logOperation({
        userId: req.session.user.id,
        action: 'import',
        resource: 'materials',
        detail: `物料导入提交：新增 ${result.imported}，更新 ${result.updated}，共 ${result.total} 条`,
        ip: req.ip
    });

    res.json({ success: true, data: result });
});

router.post('/import/inventory-workbook/preview', requirePermission('materials', 'add'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('请选择库存状况表文件');

    cleanupPreviewStore(inventoryWorkbookPreviewStore);
    const db = getDB();
    const rows = await parseInventoryWorkbook(req.file);
    if (!rows.length) throw new ValidationError('库存状况表中没有可导入的物料数据');

    const activeWarehouse = db.prepare('SELECT id, name FROM warehouses WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    if (!activeWarehouse) throw new ValidationError('系统中没有可用仓库，请先创建仓库');

    const categoryCache = new Map(db.prepare('SELECT id, name FROM categories').all().map(item => [item.name, item.id]));
    const existingByCode = new Map(db.prepare('SELECT id, code, name FROM materials WHERE code IS NOT NULL').all().map(item => [item.code, item]));

    const items = [];
    const summary = { total: rows.length, creatable: 0, updatable: 0, invalid: 0, stockSyncable: 0 };

    rows.forEach(row => {
        const existing = row.code ? existingByCode.get(row.code) : null;
        const item = {
            row: row.rowNumber,
            action: existing ? 'update' : 'create',
            code: row.code,
            name: row.name,
            normalized: row,
            warehouseId: activeWarehouse.id,
            warehouseName: activeWarehouse.name,
            warnings: [],
            errors: []
        };

        if (!row.name) item.errors.push('商品名称不能为空');
        if (!row.code) item.errors.push('商品编号不能为空');
        if (!row.unit) item.errors.push('基本单位不能为空');
        if (row.inventoryQty === null || row.inventoryQty === undefined) item.errors.push('账面库存不能为空');
        if (row.categoryName && !categoryCache.has(row.categoryName)) {
            item.warnings.push(`分类 "${row.categoryName}" 不存在，提交时将自动创建`);
        }

        if (item.errors.length) {
            item.action = 'invalid';
            summary.invalid++;
        } else if (existing) {
            item.materialId = existing.id;
            summary.updatable++;
            summary.stockSyncable++;
        } else {
            summary.creatable++;
            summary.stockSyncable++;
        }

        items.push(item);
    });

    const previewToken = buildPreviewToken('inventory_workbook');
    inventoryWorkbookPreviewStore.set(previewToken, {
        createdBy: req.session.user.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        items,
        summary
    });

    res.json({
        success: true,
        data: {
            previewToken,
            warehouse: activeWarehouse,
            summary,
            items
        }
    });
}));

router.post('/import/inventory-workbook/commit', requirePermission('materials', 'add'), (req, res) => {
    cleanupPreviewStore(inventoryWorkbookPreviewStore);
    const { previewToken, warehouseId } = req.body || {};
    if (!previewToken) throw new ValidationError('缺少 previewToken');
    const preview = inventoryWorkbookPreviewStore.get(previewToken);
    if (!preview || preview.createdBy !== req.session.user.id) {
        throw new ValidationError('库存状况表导入预览已失效，请重新上传文件');
    }

    const invalidItems = preview.items.filter(item => item.action === 'invalid');
    if (invalidItems.length > 0) {
        throw new ValidationError(`存在 ${invalidItems.length} 条无效数据，无法提交`);
    }

    const db = getDB();
    const finalWarehouseId = Number(warehouseId || preview.items[0]?.warehouseId || 0);
    const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ? AND is_active = 1').get(finalWarehouseId);
    if (!warehouse) throw new ValidationError('指定仓库不存在或已停用');

    const categoryCache = new Map(db.prepare('SELECT id, name FROM categories').all().map(item => [item.name, item.id]));
    const doCommit = db.transaction(() => {
        let imported = 0;
        let updated = 0;
        let stockUpdated = 0;

        preview.items.forEach(item => {
            const row = item.normalized;
            let categoryId = null;
            if (row.categoryName) {
                if (categoryCache.has(row.categoryName)) {
                    categoryId = categoryCache.get(row.categoryName);
                } else {
                    const { fullPinyin, abbr } = generatePinyinFields(row.categoryName);
                    const result = db.prepare(`
                        INSERT INTO categories (name, name_pinyin, name_pinyin_abbr)
                        VALUES (?, ?, ?)
                    `).run(row.categoryName, fullPinyin, abbr);
                    categoryId = Number(result.lastInsertRowid);
                    categoryCache.set(row.categoryName, categoryId);
                }
            }

            let materialId = item.materialId;
            if (materialId) {
                db.prepare(`
                    UPDATE materials
                    SET name = ?, category_id = ?, spec = ?, unit = ?, brand = ?, cost_price = ?, sale_price = ?, avg_cost = ?, standard_cost = ?,
                        updated_at = datetime('now','localtime')
                    WHERE id = ?
                `).run(
                    row.name,
                    categoryId,
                    row.spec || null,
                    row.unit,
                    row.brand || null,
                    Number(row.costPrice || 0),
                    Number(row.salePrice || 0),
                    Number(row.costPrice || 0),
                    Number(row.costPrice || 0),
                    materialId
                );
                updated++;
            } else {
                const { fullPinyin, abbr } = generatePinyinFields(row.name);
                const result = db.prepare(`
                    INSERT INTO materials (
                        code, internal_code, name, name_pinyin, name_pinyin_abbr, category_id, unit, spec, brand,
                        cost_price, sale_price, avg_cost, standard_cost, material_type, lifecycle_status, is_active
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'raw', 'active', 1)
                `).run(
                    row.code,
                    row.code,
                    row.name,
                    fullPinyin,
                    abbr,
                    categoryId,
                    row.unit,
                    row.spec || null,
                    row.brand || null,
                    Number(row.costPrice || 0),
                    Number(row.salePrice || 0),
                    Number(row.costPrice || 0),
                    Number(row.costPrice || 0)
                );
                materialId = Number(result.lastInsertRowid);
                imported++;
            }

            const inventoryRow = db.prepare(`
                SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?
            `).get(materialId, warehouse.id);
            if (inventoryRow) {
                db.prepare(`
                    UPDATE inventory
                    SET quantity = ?, updated_at = datetime('now','localtime')
                    WHERE id = ?
                `).run(Number(row.inventoryQty || 0), inventoryRow.id);
            } else {
                db.prepare(`
                    INSERT INTO inventory (material_id, warehouse_id, quantity, updated_at)
                    VALUES (?, ?, ?, datetime('now','localtime'))
                `).run(materialId, warehouse.id, Number(row.inventoryQty || 0));
            }
            stockUpdated++;
        });

        return {
            total: preview.items.length,
            imported,
            updated,
            stockUpdated,
            warehouseName: warehouse.name
        };
    });

    const result = doCommit();
    inventoryWorkbookPreviewStore.delete(previewToken);

    logOperation({
        userId: req.session.user.id,
        action: 'import',
        resource: 'materials',
        detail: `导入库存状况表：新增 ${result.imported}，更新 ${result.updated}，库存同步 ${result.stockUpdated}，仓库 ${result.warehouseName}`,
        ip: req.ip
    });

    res.json({ success: true, data: result });
});

router.post('/import/supplier-price-workbook/preview', requirePermission('materials', 'add'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('请选择供应商价格本文件');

    cleanupPreviewStore(supplierPricePreviewStore);
    const db = getDB();
    const rows = await parseSupplierPriceWorkbook(req.file);
    if (!rows.length) throw new ValidationError('供应商价格本中没有可导入的数据');

    const materialsByCode = new Map(db.prepare('SELECT id, code, name, spec, model FROM materials WHERE is_active = 1 AND code IS NOT NULL').all().map(item => [item.code, item]));
    const materialsByName = db.prepare('SELECT id, code, name, spec, model FROM materials WHERE is_active = 1').all();
    const items = [];
    const summary = { total: rows.length, creatable: 0, updatable: 0, unmatched: 0, invalid: 0 };

    rows.forEach(row => {
        let material = row.materialCode ? materialsByCode.get(row.materialCode) : null;
        if (!material && row.materialName) {
            material = materialsByName.find(item => item.name === row.materialName && (!row.model || item.model === row.model)) ||
                materialsByName.find(item => item.name === row.materialName && (!row.spec || item.spec === row.spec)) ||
                materialsByName.find(item => item.name === row.materialName) ||
                null;
        }

        const previewItem = {
            row: row.rowNumber,
            action: 'create',
            supplierName: row.supplierName,
            materialCode: row.materialCode,
            materialName: row.materialName,
            normalized: row,
            warnings: [],
            errors: []
        };

        if (!row.supplierName) previewItem.errors.push('往来单位名称不能为空');
        if (!row.materialCode && !row.materialName) previewItem.errors.push('商品编号或商品名称至少填写一个');
        if (!material) {
            previewItem.errors.push('未匹配到系统物料');
            previewItem.action = 'unmatched';
            summary.unmatched++;
        } else {
            previewItem.materialId = material.id;
            previewItem.materialCode = material.code;
            previewItem.materialName = material.name;
            const existing = db.prepare(`
                SELECT id
                FROM material_supplier_prices
                WHERE material_id = ?
                  AND supplier_name = ?
                  AND COALESCE(supplier_code, '') = COALESCE(?, '')
                ORDER BY id DESC
                LIMIT 1
            `).get(material.id, row.supplierName, row.supplierCode || '');
            if (existing) {
                previewItem.priceId = existing.id;
                previewItem.action = 'update';
                summary.updatable++;
            } else {
                summary.creatable++;
            }
        }

        if (previewItem.errors.length && previewItem.action !== 'unmatched') {
            previewItem.action = 'invalid';
            summary.invalid++;
        }

        items.push(previewItem);
    });

    const previewToken = buildPreviewToken('supplier_price_workbook');
    supplierPricePreviewStore.set(previewToken, {
        createdBy: req.session.user.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        items,
        summary
    });

    res.json({ success: true, data: { previewToken, summary, items } });
}));

router.post('/import/supplier-price-workbook/commit', requirePermission('materials', 'add'), (req, res) => {
    cleanupPreviewStore(supplierPricePreviewStore);
    const { previewToken } = req.body || {};
    if (!previewToken) throw new ValidationError('缺少 previewToken');
    const preview = supplierPricePreviewStore.get(previewToken);
    if (!preview || preview.createdBy !== req.session.user.id) {
        throw new ValidationError('供应商价格本导入预览已失效，请重新上传文件');
    }

    const invalidItems = preview.items.filter(item => item.action === 'invalid' || item.action === 'unmatched');
    if (invalidItems.length > 0) {
        throw new ValidationError(`存在 ${invalidItems.length} 条未匹配或无效数据，无法提交`);
    }

    const db = getDB();
    const doCommit = db.transaction(() => {
        let imported = 0;
        let updated = 0;
        let supplierLinksCreated = 0;

        preview.items.forEach(item => {
            const row = item.normalized;
            const materialId = Number(item.materialId);
            const quotedDiscount = row.quotedDiscount == null ? 1 : Number(row.quotedDiscount);
            const lastPurchaseDiscount = row.lastPurchaseDiscount == null ? 1 : Number(row.lastPurchaseDiscount);
            const effectivePrice = row.quotedPrice == null ? null : Number((Number(row.quotedPrice) * quotedDiscount).toFixed(4));
            const lastPurchaseEffectivePrice = row.lastPurchasePrice == null ? null : Number((Number(row.lastPurchasePrice) * lastPurchaseDiscount).toFixed(4));

            if (item.priceId) {
                db.prepare(`
                    UPDATE material_supplier_prices
                    SET supplier_code = ?, quoted_price = ?, quoted_discount = ?, effective_price = ?,
                        last_purchase_price = ?, last_purchase_discount = ?, last_purchase_effective_price = ?, last_purchase_at = ?,
                        unit = ?, spec = ?, model = ?, source_platform = ?, raw_source = ?, updated_at = datetime('now','localtime')
                    WHERE id = ?
                `).run(
                    row.supplierCode || null,
                    row.quotedPrice ?? null,
                    quotedDiscount,
                    effectivePrice,
                    row.lastPurchasePrice ?? null,
                    lastPurchaseDiscount,
                    lastPurchaseEffectivePrice,
                    row.lastPurchaseAt || null,
                    row.unit || null,
                    row.spec || null,
                    row.model || null,
                    row.sourcePlatform || 'offline',
                    JSON.stringify(row.raw || {}),
                    item.priceId
                );
                updated++;
            } else {
                db.prepare(`
                    INSERT INTO material_supplier_prices (
                        material_id, supplier_name, supplier_code, quoted_price, quoted_discount, effective_price,
                        last_purchase_price, last_purchase_discount, last_purchase_effective_price, last_purchase_at,
                        unit, spec, model, source_platform, raw_source
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    materialId,
                    row.supplierName,
                    row.supplierCode || null,
                    row.quotedPrice ?? null,
                    quotedDiscount,
                    effectivePrice,
                    row.lastPurchasePrice ?? null,
                    lastPurchaseDiscount,
                    lastPurchaseEffectivePrice,
                    row.lastPurchaseAt || null,
                    row.unit || null,
                    row.spec || null,
                    row.model || null,
                    row.sourcePlatform || 'offline',
                    JSON.stringify(row.raw || {})
                );
                imported++;
            }

            const supplierLink = db.prepare(`
                SELECT id FROM material_suppliers
                WHERE material_id = ? AND supplier_name = ?
                ORDER BY is_default DESC, id ASC
                LIMIT 1
            `).get(materialId, row.supplierName);
            if (!supplierLink) {
                db.prepare(`
                    INSERT INTO material_suppliers (
                        material_id, supplier_name, supplier_material_code, is_default, lead_time_days, min_order_qty, lot_size,
                        last_purchase_price, supplier_type, source_platform, notes
                    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?, 'distributor', ?, ?)
                `).run(materialId, row.supplierName, row.supplierCode || null, row.lastPurchasePrice ?? 0, row.sourcePlatform || 'offline', '由供应商价格本导入');
                supplierLinksCreated++;
            } else {
                db.prepare(`
                    UPDATE material_suppliers
                    SET supplier_material_code = COALESCE(?, supplier_material_code),
                        last_purchase_price = COALESCE(?, last_purchase_price),
                        source_platform = COALESCE(?, source_platform),
                        updated_at = datetime('now','localtime')
                    WHERE id = ?
                `).run(row.supplierCode || null, row.lastPurchasePrice ?? null, row.sourcePlatform || null, supplierLink.id);
            }
        });

        return { total: preview.items.length, imported, updated, supplierLinksCreated };
    });

    const result = doCommit();
    supplierPricePreviewStore.delete(previewToken);

    logOperation({
        userId: req.session.user.id,
        action: 'import',
        resource: 'materials',
        detail: `导入供应商价格本：新增 ${result.imported}，更新 ${result.updated}，补充供应商关系 ${result.supplierLinksCreated}`,
        ip: req.ip
    });

    res.json({ success: true, data: result });
});

router.post('/:id/merge', requirePermission('materials', 'edit'), (req, res) => {
    const db = getDB();
    const sourceId = Number(req.params.id);
    const targetMaterialId = parseNumberField(req.body.targetMaterialId ?? req.body.target_material_id, 'targetMaterialId');
    const reason = trimText(req.body.reason) || '重复物料合并';

    if (!targetMaterialId) throw new ValidationError('请选择目标主档', 'targetMaterialId');
    if (sourceId === targetMaterialId) throw new ValidationError('源物料和目标物料不能相同');

    const source = db.prepare('SELECT * FROM materials WHERE id = ?').get(sourceId);
    const target = db.prepare('SELECT * FROM materials WHERE id = ?').get(targetMaterialId);
    if (!source) throw new NotFoundError('源物料');
    if (!target) throw new NotFoundError('目标物料');
    if (source.lifecycle_status === 'obsolete') throw new ValidationError('源物料已淘汰，不能再次合并');

    const doMerge = db.transaction(() => {
        const sourceInventory = db.prepare('SELECT * FROM inventory WHERE material_id = ?').all(sourceId);
        sourceInventory.forEach(row => {
            const targetInventory = db.prepare(`
                SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?
            `).get(targetMaterialId, row.warehouse_id);
            if (targetInventory) {
                db.prepare(`
                    UPDATE inventory
                    SET quantity = quantity + ?, updated_at = datetime('now', 'localtime')
                    WHERE id = ?
                `).run(row.quantity, targetInventory.id);
                db.prepare('DELETE FROM inventory WHERE id = ?').run(row.id);
            } else {
                db.prepare(`
                    UPDATE inventory
                    SET material_id = ?, updated_at = datetime('now', 'localtime')
                    WHERE id = ?
                `).run(targetMaterialId, row.id);
            }
        });

        db.prepare('UPDATE shipment_items SET material_id = ? WHERE material_id = ?').run(targetMaterialId, sourceId);
        db.prepare('UPDATE bom_items SET material_id = ? WHERE material_id = ?').run(targetMaterialId, sourceId);
        db.prepare('UPDATE boms SET output_material_id = ? WHERE output_material_id = ?').run(targetMaterialId, sourceId);
        db.prepare('UPDATE production_orders SET output_material_id = ? WHERE output_material_id = ?').run(targetMaterialId, sourceId);

        const sopRows = db.prepare('SELECT * FROM sop_materials WHERE material_id = ?').all(sourceId);
        sopRows.forEach(row => {
            const existing = db.prepare(`
                SELECT id, quantity_per_unit FROM sop_materials
                WHERE sop_id = ? AND material_id = ? AND (
                    (step_id IS NULL AND ? IS NULL) OR step_id = ?
                )
            `).get(row.sop_id, targetMaterialId, row.step_id, row.step_id);
            if (existing) {
                db.prepare(`
                    UPDATE sop_materials SET quantity_per_unit = quantity_per_unit + ?
                    WHERE id = ?
                `).run(row.quantity_per_unit, existing.id);
                db.prepare('DELETE FROM sop_materials WHERE id = ?').run(row.id);
            } else {
                db.prepare('UPDATE sop_materials SET material_id = ? WHERE id = ?').run(targetMaterialId, row.id);
            }
        });

        const sourceUoms = db.prepare('SELECT * FROM material_uoms WHERE material_id = ?').all(sourceId);
        sourceUoms.forEach(row => {
            const exists = db.prepare(`
                SELECT id FROM material_uoms
                WHERE material_id = ? AND uom_type = ? AND unit_name = ? AND ratio_to_base = ?
            `).get(targetMaterialId, row.uom_type, row.unit_name, row.ratio_to_base);
            if (exists) {
                db.prepare('DELETE FROM material_uoms WHERE id = ?').run(row.id);
            } else {
                db.prepare('UPDATE material_uoms SET material_id = ? WHERE id = ?').run(targetMaterialId, row.id);
            }
        });

        const sourceSuppliers = db.prepare('SELECT * FROM material_suppliers WHERE material_id = ?').all(sourceId);
        sourceSuppliers.forEach(row => {
            const exists = db.prepare(`
                SELECT id FROM material_suppliers
                WHERE material_id = ? AND supplier_name = ? AND COALESCE(supplier_material_code, '') = COALESCE(?, '')
            `).get(targetMaterialId, row.supplier_name, row.supplier_material_code);
            if (exists) {
                db.prepare('DELETE FROM material_suppliers WHERE id = ?').run(row.id);
            } else {
                db.prepare('UPDATE material_suppliers SET material_id = ? WHERE id = ?').run(targetMaterialId, row.id);
            }
        });

        db.prepare('DELETE FROM material_substitutions WHERE material_id = ? AND substitute_material_id = ?').run(sourceId, targetMaterialId);
        db.prepare('DELETE FROM material_substitutions WHERE material_id = ? AND substitute_material_id = ?').run(targetMaterialId, sourceId);

        const substitutionRows = db.prepare(`
            SELECT *
            FROM material_substitutions
            WHERE material_id = ? OR substitute_material_id = ?
            ORDER BY id ASC
        `).all(sourceId, sourceId);
        substitutionRows.forEach(row => {
            const nextMaterialId = row.material_id === sourceId ? targetMaterialId : row.material_id;
            const nextSubstituteId = row.substitute_material_id === sourceId ? targetMaterialId : row.substitute_material_id;

            if (nextMaterialId === nextSubstituteId) {
                db.prepare('DELETE FROM material_substitutions WHERE id = ?').run(row.id);
                return;
            }

            const duplicate = db.prepare(`
                SELECT id FROM material_substitutions
                WHERE material_id = ? AND substitute_material_id = ? AND id != ?
            `).get(nextMaterialId, nextSubstituteId, row.id);

            if (duplicate) {
                db.prepare('DELETE FROM material_substitutions WHERE id = ?').run(row.id);
                return;
            }

            db.prepare(`
                UPDATE material_substitutions
                SET material_id = ?, substitute_material_id = ?, updated_at = datetime('now', 'localtime')
                WHERE id = ?
            `).run(nextMaterialId, nextSubstituteId, row.id);
        });

        db.prepare(`
            INSERT INTO material_merge_logs (source_material_id, target_material_id, reason, changed_by)
            VALUES (?, ?, ?, ?)
        `).run(sourceId, targetMaterialId, reason, req.session.user.id);

        db.prepare(`
            UPDATE materials
            SET lifecycle_status = 'obsolete',
                is_active = 0,
                obsolete_at = datetime('now', 'localtime'),
                updated_at = datetime('now', 'localtime'),
                data_quality_status = 'normal'
            WHERE id = ?
        `).run(sourceId);

        db.prepare(`
            INSERT INTO material_lifecycle_logs (material_id, from_status, to_status, reason, changed_by)
            VALUES (?, ?, 'obsolete', ?, ?)
        `).run(sourceId, source.lifecycle_status, `合并到物料 ${target.code}`, req.session.user.id);
    });

    doMerge();

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'materials',
        resourceId: sourceId,
        detail: `合并物料: ${source.name}(${source.code}) -> ${target.name}(${target.code})`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            sourceMaterialId: sourceId,
            targetMaterialId,
            sourceCode: source.code,
            targetCode: target.code
        }
    });
});

router.get('/:id/usages', requirePermission('materials', 'view'), (req, res) => {
    const db = getDB();
    const material = db.prepare('SELECT id, code, name FROM materials WHERE id = ?').get(req.params.id);
    if (!material) throw new NotFoundError('物料');

    const usages = getMaterialUsageDetails(db, req.params.id);
    res.json({
        success: true,
        data: {
            material,
            ...usages,
            summary: {
                bomCount: usages.boms.length,
                sopCount: usages.sops.length,
                shipmentCount: usages.shipments.length,
                productionOrderCount: usages.productionOrders.length,
                inventoryRowCount: usages.inventoryRows.length
            }
        }
    });
});

router.put('/:id/lifecycle', requirePermission('materials', 'edit'), (req, res) => {
    const db = getDB();
    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
    if (!material) throw new NotFoundError('物料');

    const toStatus = trimText(req.body.toStatus ?? req.body.lifecycleStatus);
    const reason = trimText(req.body.reason ?? req.body.lifecycleReason);
    if (!toStatus || !LIFECYCLE_STATUSES.includes(toStatus)) {
        throw new ValidationError('无效的生命周期状态', 'toStatus');
    }

    if (material.lifecycle_status === toStatus) {
        return res.json({ success: true, data: { id: material.id, fromStatus: material.lifecycle_status, toStatus } });
    }

    const allowedTargets = getLifecycleTransitionTargets(material.lifecycle_status);
    if (!allowedTargets.includes(toStatus)) {
        throw new ValidationError(`无法从 "${material.lifecycle_status}" 变更为 "${toStatus}"`);
    }

    const stock = db.prepare('SELECT COALESCE(SUM(quantity), 0) as total FROM inventory WHERE material_id = ?').get(req.params.id).total;
    if ((toStatus === 'inactive' || toStatus === 'obsolete') && stock > 0) {
        throw new ValidationError(`当前物料仍有 ${stock} ${material.unit} 库存，不能直接停用/淘汰`);
    }

    const doUpdate = db.transaction(() => {
        db.prepare(`
            UPDATE materials
            SET lifecycle_status = ?,
                is_active = CASE WHEN ? IN ('inactive', 'obsolete') THEN 0 ELSE is_active END,
                activated_at = CASE WHEN ? = 'active' AND activated_at IS NULL THEN datetime('now', 'localtime') ELSE activated_at END,
                obsolete_at = CASE WHEN ? = 'obsolete' THEN datetime('now', 'localtime') ELSE obsolete_at END,
                version_no = version_no + 1,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(toStatus, toStatus, toStatus, toStatus, req.params.id);

        db.prepare(`
            INSERT INTO material_lifecycle_logs (material_id, from_status, to_status, reason, changed_by)
            VALUES (?, ?, ?, ?, ?)
        `).run(req.params.id, material.lifecycle_status, toStatus, reason, req.session.user.id);
    });

    doUpdate();

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'materials',
        resourceId: Number(req.params.id),
        detail: `物料生命周期变更: ${material.name} ${material.lifecycle_status} -> ${toStatus}`,
        ip: req.ip
    });

    res.json({ success: true, data: { id: material.id, fromStatus: material.lifecycle_status, toStatus } });
});

router.get('/:id/substitutions', requirePermission('materials', 'view'), (req, res) => {
    const db = getDB();
    const material = db.prepare('SELECT id, code, name FROM materials WHERE id = ?').get(req.params.id);
    if (!material) throw new NotFoundError('物料');

    const items = db.prepare(`
        SELECT ms.*, m.code as substitute_material_code, m.name as substitute_material_name,
               m.material_type as substitute_material_type, m.lifecycle_status as substitute_lifecycle_status
        FROM material_substitutions ms
        JOIN materials m ON m.id = ms.substitute_material_id
        WHERE ms.material_id = ?
        ORDER BY ms.priority ASC, ms.id ASC
    `).all(req.params.id);

    res.json({ success: true, data: { material, items } });
});

router.post('/:id/substitutions', requirePermission('materials', 'edit'), (req, res) => {
    const db = getDB();
    const material = db.prepare('SELECT id, name FROM materials WHERE id = ?').get(req.params.id);
    if (!material) throw new NotFoundError('物料');

    const substituteMaterialId = parseNumberField(req.body.substituteMaterialId ?? req.body.substitute_material_id, 'substituteMaterialId');
    const priority = parseNumberField(req.body.priority, 'priority') ?? 1;
    const substitutionType = trimText(req.body.substitutionType ?? req.body.substitution_type) || 'full';
    const reason = trimText(req.body.reason);
    const isActive = parseBooleanFlag(req.body.isActive ?? req.body.is_active) ?? 1;

    if (!substituteMaterialId) throw new ValidationError('请选择替代物料', 'substituteMaterialId');
    if (substituteMaterialId === Number(req.params.id)) throw new ValidationError('物料不能替代自身', 'substituteMaterialId');
    if (!['full', 'temporary', 'conditional'].includes(substitutionType)) {
        throw new ValidationError('无效的替代类型', 'substitutionType');
    }

    const substitute = db.prepare('SELECT id, name, lifecycle_status FROM materials WHERE id = ?').get(substituteMaterialId);
    if (!substitute) throw new NotFoundError('替代物料');
    if (substitute.lifecycle_status !== 'active') throw new ValidationError('只能选择启用中的物料作为替代料');

    const existing = db.prepare(`
        SELECT id FROM material_substitutions
        WHERE material_id = ? AND substitute_material_id = ?
    `).get(req.params.id, substituteMaterialId);
    if (existing) throw new ConflictError('该替代关系已存在');

    const result = db.prepare(`
        INSERT INTO material_substitutions (
            material_id, substitute_material_id, priority, substitution_type, reason, is_active, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, substituteMaterialId, priority, substitutionType, reason, isActive, req.session.user.id);

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'materials',
        resourceId: Number(req.params.id),
        detail: `新增替代料: ${material.name} -> ${substitute.name}`,
        ip: req.ip
    });

    res.status(201).json({ success: true, data: { id: result.lastInsertRowid } });
});

router.delete('/:id/substitutions/:subId', requirePermission('materials', 'edit'), (req, res) => {
    const db = getDB();
    const relation = db.prepare(`
        SELECT ms.*, m.name as substitute_name
        FROM material_substitutions ms
        JOIN materials m ON m.id = ms.substitute_material_id
        WHERE ms.id = ? AND ms.material_id = ?
    `).get(req.params.subId, req.params.id);
    if (!relation) throw new NotFoundError('替代料关系');

    db.prepare('DELETE FROM material_substitutions WHERE id = ?').run(req.params.subId);

    logOperation({
        userId: req.session.user.id,
        action: 'delete',
        resource: 'materials',
        resourceId: Number(req.params.id),
        detail: `删除替代料: 关系ID ${req.params.subId} -> ${relation.substitute_name}`,
        ip: req.ip
    });

    res.json({ success: true, message: '替代料关系已删除' });
});

/**
 * GET /api/materials/:id
 * 物料详情（含各仓库库存明细）
 */
router.get('/:id', requirePermission('materials', 'view'), (req, res) => {
    const db = getDB();
    const material = db.prepare(`
        SELECT m.*, c.name as category_name
        FROM materials m
        LEFT JOIN categories c ON m.category_id = c.id
        WHERE m.id = ?
    `).get(req.params.id);

    if (!material) throw new NotFoundError('物料');

    // 各仓库库存
    const inventory = db.prepare(`
        SELECT i.*, w.name as warehouse_name
        FROM inventory i
        JOIN warehouses w ON i.warehouse_id = w.id
        WHERE i.material_id = ?
        ORDER BY w.name
    `).all(req.params.id);

    // 最近出入库记录
    const recentMovements = db.prepare(`
        SELECT sm.*, w.name as warehouse_name, u.display_name as operator_name
        FROM stock_movements sm
        JOIN warehouses w ON sm.warehouse_id = w.id
        LEFT JOIN users u ON sm.created_by = u.id
        WHERE sm.material_id = ?
        ORDER BY sm.created_at DESC
        LIMIT 20
    `).all(req.params.id);

    const uoms = db.prepare(`
        SELECT *
        FROM material_uoms
        WHERE material_id = ?
        ORDER BY CASE uom_type WHEN 'base' THEN 0 WHEN 'purchase' THEN 1 WHEN 'production' THEN 2 ELSE 3 END, id
    `).all(req.params.id);

    const suppliers = db.prepare(`
        SELECT *
        FROM material_suppliers
        WHERE material_id = ?
        ORDER BY is_default DESC, id ASC
    `).all(req.params.id);

    const supplierPrices = hasTable(db, 'material_supplier_prices')
        ? db.prepare(`
            SELECT *
            FROM material_supplier_prices
            WHERE material_id = ? AND COALESCE(is_active, 1) = 1
            ORDER BY is_default DESC, COALESCE(last_purchase_at, '') DESC, id DESC
        `).all(req.params.id)
        : [];

    const substitutions = db.prepare(`
        SELECT ms.*, m.code as substitute_material_code, m.name as substitute_material_name
        FROM material_substitutions ms
        JOIN materials m ON m.id = ms.substitute_material_id
        WHERE ms.material_id = ?
        ORDER BY ms.priority ASC, ms.id ASC
    `).all(req.params.id);

    const usageDetails = getMaterialUsageDetails(db, req.params.id);
    const mergeDetails = getMaterialMergeDetails(db, req.params.id);
    const usageSummary = {
        bomCount: usageDetails.bomUsageTotal || usageDetails.boms.length,
        sopCount: usageDetails.sops.length,
        shipmentCount: usageDetails.shipments.length,
        outputOrderCount: usageDetails.productionOrders.length,
        inventoryRowCount: usageDetails.inventoryRows.length,
        mergedSourceCount: mergeDetails.mergedSources.length,
        mergedIntoCount: mergeDetails.mergedInto ? 1 : 0
    };

    res.json({
        success: true,
        data: {
            material,
            inventory,
            recentMovements,
            uoms,
            suppliers,
            supplierPrices,
            lastPurchaseReference: getLastPurchaseReference(db, req.params.id),
            supplyRisk: getMaterialSupplyRisk(db, req.params.id),
            substitutions,
            mergeDetails,
            usageSummary,
            usages: usageDetails
        }
    });
});

/**
 * POST /api/materials
 * 创建物料
 */
router.post('/', requirePermission('materials', 'add'), (req, res) => {
    const db = getDB();
    const payload = normalizeMaterialPayload(req.body);

    // 生成拼音索引
    const { fullPinyin, abbr } = generatePinyinFields(payload.name);

    const doCreate = db.transaction(() => {
        const materialCode = payload.code || generateMaterialCode(db);
        const insertPlaceholders = new Array(62).fill('?').join(', ');

        const existing = db.prepare('SELECT id FROM materials WHERE code = ?').get(materialCode);
        if (existing) throw new ConflictError(`物料编码 ${materialCode} 已存在`);

        const result = db.prepare(`
            INSERT INTO materials (
                code, name, name_pinyin, name_pinyin_abbr,
                category_id, unit, spec, brand, description,
                min_stock, max_stock, cost_price, sale_price,
                image_url, barcode, weight, dimensions,
                supplier, supplier_contact, notes, created_by,
                material_type, supply_mode, internal_code, model, spec_key,
                is_purchasable, is_producible, is_sellable,
                default_warehouse_id, default_supplier_id, lead_time_days,
                min_purchase_qty, purchase_lot_size, tax_rate,
                safety_stock, reorder_point, target_coverage_qty, coverage_days_target, economic_order_qty,
                is_single_source, supply_risk_level, supply_risk_notes,
                allow_negative_stock, is_batch_tracked, is_serial_tracked, is_expiry_tracked,
                stock_count_cycle_days, standard_cost, last_purchase_price, avg_cost, cost_source, cost_updated_at,
                lifecycle_status, activated_at, default_bom_id, default_sop_id, yield_rate, scrap_rate,
                is_key_part, master_data_owner, data_quality_status
            ) VALUES (${insertPlaceholders})
        `).run(
            materialCode, payload.name, fullPinyin, abbr,
            payload.categoryId || null, payload.unit, payload.spec, payload.brand, payload.description,
            payload.minStock ?? 0, payload.maxStock, payload.costPrice ?? 0, payload.salePrice ?? 0,
            payload.imageUrl, payload.barcode, payload.weight, payload.dimensions,
            payload.supplier, payload.supplierContact, payload.notes, req.session.user.id,
            payload.materialType, payload.supplyMode || 'direct_issue', payload.internalCode || materialCode, payload.model,
            buildSpecKey(payload.name, payload.spec, payload.brand, payload.unit),
            payload.isPurchasable ?? 0, payload.isProducible ?? 0, payload.isSellable ?? 0,
            payload.defaultWarehouseId, payload.defaultSupplierId, payload.leadTimeDays ?? 0,
            payload.minPurchaseQty ?? 0, payload.purchaseLotSize ?? 0, payload.taxRate ?? 0,
            payload.safetyStock ?? payload.minStock ?? 0, payload.reorderPoint ?? payload.minStock ?? 0, payload.targetCoverageQty ?? 0, payload.coverageDaysTarget ?? 0, payload.economicOrderQty ?? 0,
            payload.isSingleSource ?? 0, payload.supplyRiskLevel || 'normal', payload.supplyRiskNotes,
            payload.allowNegativeStock ?? 0, payload.isBatchTracked ?? 0, payload.isSerialTracked ?? 0, payload.isExpiryTracked ?? 0,
            payload.stockCountCycleDays, payload.standardCost ?? payload.costPrice ?? 0, 0, payload.avgCost ?? payload.costPrice ?? 0, 'manual', new Date().toISOString(),
            payload.lifecycleStatus, payload.lifecycleStatus === 'active' ? new Date().toISOString() : null, payload.defaultBomId, payload.defaultSopId, payload.yieldRate ?? 1, payload.scrapRate ?? 0,
            payload.isKeyPart ?? 0, payload.masterDataOwner, payload.dataQualityStatus || 'normal'
        );

        const materialId = result.lastInsertRowid;
        replaceMaterialRelations(db, materialId, {
            ...payload,
            uoms: payload.uoms || [{ uomType: 'base', unitName: payload.unit, ratioToBase: 1, isDefault: 1 }]
        }, req.session.user.id);

        return { id: materialId, materialCode };
    });

    const { id: newId, materialCode } = doCreate();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'materials',
        resourceId: newId,
        detail: `创建物料: ${payload.name} (${materialCode})`,
        ip: req.ip
    });

    res.status(201).json({
        success: true,
        data: {
            id: newId,
            code: materialCode,
            name: payload.name
        }
    });
});

/**
 * PUT /api/materials/:id
 * 修改物料
 */
router.put('/:id', requirePermission('materials', 'edit'), (req, res) => {
    const { id } = req.params;
    const db = getDB();
    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
    if (!material) throw new NotFoundError('物料');
    const payload = normalizeMaterialPayload(req.body, material);

    if (payload.versionNo !== undefined && payload.versionNo !== material.version_no) {
        throw new ConflictError('物料已被其他用户修改，请刷新后重试');
    }

    if (payload.code && payload.code !== material.code) {
        const existing = db.prepare('SELECT id FROM materials WHERE code = ? AND id != ?').get(payload.code, id);
        if (existing) throw new ConflictError(`物料编码 ${payload.code} 已存在`);
    }

    const finalName = payload.name;
    let pinyinFields = { fullPinyin: material.name_pinyin, abbr: material.name_pinyin_abbr };
    if (payload.name !== material.name) {
        pinyinFields = generatePinyinFields(finalName);
    }

    const doUpdate = db.transaction(() => {
        db.prepare(`
            UPDATE materials SET
                code = ?,
                internal_code = ?,
                name = ?,
                name_pinyin = ?,
                name_pinyin_abbr = ?,
                category_id = ?,
                unit = ?,
                spec = ?,
                brand = ?,
                description = ?,
                min_stock = ?,
                max_stock = ?,
                cost_price = ?,
                sale_price = ?,
                image_url = ?,
                barcode = ?,
                model = ?,
                weight = ?,
                dimensions = ?,
                supplier = ?,
                supplier_contact = ?,
                notes = ?,
                material_type = ?,
                supply_mode = ?,
                is_purchasable = ?,
                is_producible = ?,
                is_sellable = ?,
                default_warehouse_id = ?,
                default_supplier_id = ?,
                lead_time_days = ?,
                min_purchase_qty = ?,
                purchase_lot_size = ?,
                tax_rate = ?,
                safety_stock = ?,
                reorder_point = ?,
                target_coverage_qty = ?,
                coverage_days_target = ?,
                economic_order_qty = ?,
                is_single_source = ?,
                supply_risk_level = ?,
                supply_risk_notes = ?,
                allow_negative_stock = ?,
                is_batch_tracked = ?,
                is_serial_tracked = ?,
                is_expiry_tracked = ?,
                stock_count_cycle_days = ?,
                standard_cost = ?,
                avg_cost = ?,
                cost_source = ?,
                cost_updated_at = datetime('now', 'localtime'),
                lifecycle_status = ?,
                activated_at = CASE
                    WHEN lifecycle_status != 'active' AND ? = 'active' THEN datetime('now', 'localtime')
                    ELSE activated_at
                END,
                obsolete_at = CASE
                    WHEN ? = 'obsolete' THEN datetime('now', 'localtime')
                    ELSE obsolete_at
                END,
                default_bom_id = ?,
                default_sop_id = ?,
                yield_rate = ?,
                scrap_rate = ?,
                is_key_part = ?,
                master_data_owner = ?,
                data_quality_status = ?,
                spec_key = ?,
                version_no = version_no + 1,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(
            payload.code || material.code,
            payload.internalCode || payload.code || material.internal_code || material.code,
            finalName,
            pinyinFields.fullPinyin,
            pinyinFields.abbr,
            payload.categoryId !== undefined ? payload.categoryId : material.category_id,
            payload.unit,
            payload.spec !== undefined ? payload.spec : material.spec,
            payload.brand !== undefined ? payload.brand : material.brand,
            payload.description !== undefined ? payload.description : material.description,
            payload.minStock !== undefined ? payload.minStock : material.min_stock,
            payload.maxStock !== undefined ? payload.maxStock : material.max_stock,
            payload.costPrice !== undefined ? payload.costPrice : material.cost_price,
            payload.salePrice !== undefined ? payload.salePrice : material.sale_price,
            payload.imageUrl !== undefined ? payload.imageUrl : material.image_url,
            payload.barcode !== undefined ? payload.barcode : material.barcode,
            payload.model !== undefined ? payload.model : material.model,
            payload.weight !== undefined ? payload.weight : material.weight,
            payload.dimensions !== undefined ? payload.dimensions : material.dimensions,
            payload.supplier !== undefined ? payload.supplier : material.supplier,
            payload.supplierContact !== undefined ? payload.supplierContact : material.supplier_contact,
            payload.notes !== undefined ? payload.notes : material.notes,
            payload.materialType || material.material_type,
            payload.supplyMode || material.supply_mode || 'direct_issue',
            payload.isPurchasable ?? material.is_purchasable,
            payload.isProducible ?? material.is_producible,
            payload.isSellable ?? material.is_sellable,
            payload.defaultWarehouseId !== undefined ? payload.defaultWarehouseId : material.default_warehouse_id,
            payload.defaultSupplierId !== undefined ? payload.defaultSupplierId : material.default_supplier_id,
            payload.leadTimeDays !== undefined ? payload.leadTimeDays : material.lead_time_days,
            payload.minPurchaseQty !== undefined ? payload.minPurchaseQty : material.min_purchase_qty,
            payload.purchaseLotSize !== undefined ? payload.purchaseLotSize : material.purchase_lot_size,
            payload.taxRate !== undefined ? payload.taxRate : material.tax_rate,
            payload.safetyStock !== undefined ? payload.safetyStock : material.safety_stock,
            payload.reorderPoint !== undefined ? payload.reorderPoint : material.reorder_point,
            payload.targetCoverageQty !== undefined ? payload.targetCoverageQty : material.target_coverage_qty,
            payload.coverageDaysTarget !== undefined ? payload.coverageDaysTarget : material.coverage_days_target,
            payload.economicOrderQty !== undefined ? payload.economicOrderQty : material.economic_order_qty,
            payload.isSingleSource ?? material.is_single_source,
            payload.supplyRiskLevel || material.supply_risk_level || 'normal',
            payload.supplyRiskNotes !== undefined ? payload.supplyRiskNotes : material.supply_risk_notes,
            payload.allowNegativeStock ?? material.allow_negative_stock,
            payload.isBatchTracked ?? material.is_batch_tracked,
            payload.isSerialTracked ?? material.is_serial_tracked,
            payload.isExpiryTracked ?? material.is_expiry_tracked,
            payload.stockCountCycleDays !== undefined ? payload.stockCountCycleDays : material.stock_count_cycle_days,
            payload.standardCost !== undefined ? payload.standardCost : material.standard_cost,
            payload.avgCost !== undefined ? payload.avgCost : material.avg_cost,
            material.cost_source || 'manual',
            payload.lifecycleStatus || material.lifecycle_status,
            payload.lifecycleStatus || material.lifecycle_status,
            payload.lifecycleStatus || material.lifecycle_status,
            payload.defaultBomId !== undefined ? payload.defaultBomId : material.default_bom_id,
            payload.defaultSopId !== undefined ? payload.defaultSopId : material.default_sop_id,
            payload.yieldRate !== undefined ? payload.yieldRate : material.yield_rate,
            payload.scrapRate !== undefined ? payload.scrapRate : material.scrap_rate,
            payload.isKeyPart ?? material.is_key_part,
            payload.masterDataOwner !== undefined ? payload.masterDataOwner : material.master_data_owner,
            payload.dataQualityStatus || material.data_quality_status || 'normal',
            buildSpecKey(
                finalName,
                payload.spec !== undefined ? payload.spec : material.spec,
                payload.brand !== undefined ? payload.brand : material.brand,
                payload.unit
            ),
            id
        );

        if (payload.lifecycleStatus && payload.lifecycleStatus !== material.lifecycle_status) {
            db.prepare(`
                INSERT INTO material_lifecycle_logs (material_id, from_status, to_status, reason, changed_by)
                VALUES (?, ?, ?, ?, ?)
            `).run(id, material.lifecycle_status, payload.lifecycleStatus, trimText(req.body.lifecycleReason ?? req.body.reason), req.session.user.id);
        }

        replaceMaterialRelations(db, id, payload, req.session.user.id);
    });

    doUpdate();

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'materials',
        resourceId: Number(id),
        detail: `修改物料: ${finalName}`,
        ip: req.ip
    });

    res.json({ success: true, message: '物料已更新' });
});

/**
 * DELETE /api/materials/:id
 * 软删除物料
 */
router.delete('/:id', requirePermission('materials', 'delete'), (req, res) => {
    const { id } = req.params;
    const db = getDB();

    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
    if (!material) throw new NotFoundError('物料');

    // 检查是否有库存
    const stock = db.prepare(
        'SELECT SUM(quantity) as total FROM inventory WHERE material_id = ?'
    ).get(id);
    if (stock && stock.total > 0) {
        throw new ValidationError(`该物料还有 ${stock.total} ${material.unit} 库存，请先清零后再删除`);
    }

    // 检查是否在活跃BOM中使用
    const bomUsage = db.prepare(`
        SELECT COUNT(*) as cnt FROM bom_items bi
        JOIN boms b ON bi.bom_id = b.id
        WHERE bi.material_id = ? AND b.is_active = 1
    `).get(id);
    if (bomUsage && bomUsage.cnt > 0) {
        throw new ValidationError(`该物料在 ${bomUsage.cnt} 个活跃BOM中使用，无法删除`);
    }

    // 检查是否在SOP中使用
    const sopUsage = db.prepare(`
        SELECT COUNT(*) as cnt FROM sop_materials sm
        JOIN sops s ON sm.sop_id = s.id
        WHERE sm.material_id = ? AND s.is_active = 1
    `).get(id);
    if (sopUsage && sopUsage.cnt > 0) {
        throw new ValidationError(`该物料在 ${sopUsage.cnt} 个活跃SOP中使用，无法删除`);
    }

    db.prepare(
        "UPDATE materials SET is_active = 0, lifecycle_status = 'inactive', updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(id);

    logOperation({
        userId: req.session.user.id,
        action: 'delete',
        resource: 'materials',
        resourceId: Number(id),
        detail: `禁用物料: ${material.name} (${material.code})`,
        ip: req.ip
    });

    res.json({ success: true, message: '物料已删除' });
});

/**
 * GET /api/categories
 * 获取分类列表
 */
router.get('/meta/categories', (req, res) => {
    const db = getDB();
    const categories = db.prepare(`
        SELECT c.*, COUNT(m.id) as material_count
        FROM categories c
        LEFT JOIN materials m ON m.category_id = c.id AND m.is_active = 1
        GROUP BY c.id
        ORDER BY c.sort_order, c.name
    `).all();

    res.json({ success: true, data: { categories } });
});

/**
 * POST /api/materials/meta/categories
 * 创建分类
 */
router.post('/meta/categories', requirePermission('categories', 'add'), (req, res) => {
    const { name, parentId } = req.body;
    if (!name || !name.trim()) throw new ValidationError('请输入分类名称', 'name');

    const db = getDB();
    const { fullPinyin, abbr } = generatePinyinFields(name.trim());

    const result = db.prepare(`
        INSERT INTO categories (name, name_pinyin, name_pinyin_abbr, parent_id)
        VALUES (?, ?, ?, ?)
    `).run(name.trim(), fullPinyin, abbr, parentId || null);

    res.status(201).json({
        success: true,
        data: { id: result.lastInsertRowid, name: name.trim() }
    });
});

/**
 * PUT /api/materials/meta/categories/:id
 */
router.put('/meta/categories/:id', requirePermission('categories', 'edit'), (req, res) => {
    const { name, parentId, sortOrder } = req.body;
    const db = getDB();

    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!cat) throw new NotFoundError('分类');

    const finalName = name?.trim() || cat.name;
    let py = { fullPinyin: cat.name_pinyin, abbr: cat.name_pinyin_abbr };
    if (name && name.trim() !== cat.name) {
        py = generatePinyinFields(finalName);
    }

    db.prepare(`
        UPDATE categories SET name = ?, name_pinyin = ?, name_pinyin_abbr = ?,
        parent_id = ?, sort_order = COALESCE(?, sort_order)
        WHERE id = ?
    `).run(finalName, py.fullPinyin, py.abbr, parentId !== undefined ? parentId : cat.parent_id, sortOrder, req.params.id);

    res.json({ success: true, message: '分类已更新' });
});

/**
 * DELETE /api/materials/meta/categories/:id
 */
router.delete('/meta/categories/:id', requirePermission('categories', 'delete'), (req, res) => {
    const db = getDB();
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!cat) throw new NotFoundError('分类');

    // 检查是否有物料使用此分类
    const count = db.prepare('SELECT COUNT(*) as cnt FROM materials WHERE category_id = ? AND is_active = 1').get(req.params.id);
    if (count.cnt > 0) {
        throw new ValidationError(`该分类下还有 ${count.cnt} 个物料，请先转移后再删除`);
    }

    // 将子分类的 parent_id 置空
    db.prepare('UPDATE categories SET parent_id = NULL WHERE parent_id = ?').run(req.params.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);

    res.json({ success: true, message: '分类已删除' });
});

module.exports = router;
