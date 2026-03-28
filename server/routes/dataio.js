/**
 * 数据导入导出路由
 * GET  /api/data/export/materials       - 导出物料
 * GET  /api/data/export/inventory       - 导出库存
 * GET  /api/data/export/movements       - 导出出入库流水
 * GET  /api/data/export/shipments       - 导出发货单
 * GET  /api/data/export/sops            - 导出SOP
 * GET  /api/data/export/production      - 导出生产工单
 * POST /api/data/import/materials       - 批量导入物料
 * GET  /api/data/import/materials/template - 下载导入模板
 */

const express = require('express');
const ExcelJS = require('exceljs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { logOperation } = require('../utils/logger');
const { ValidationError, asyncHandler } = require('../utils/errors');
const { generatePinyinFields } = require('../utils/pinyin');

const router = express.Router();
router.use(requireAuth);

// 文件上传配置（内存存储，最大5MB）
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.csv', '.xlsx', '.xls', '.json'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new ValidationError('仅支持 .csv、.xlsx、.json 格式文件'));
        }
    }
});

// ===================== 辅助函数 =====================

/**
 * 设置响应头用于文件下载
 */
function setDownloadHeaders(res, filename, contentType) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-cache');
}

/**
 * 生成时间戳后缀
 */
function timestamp() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * 将数据导出为 CSV 字符串（带 UTF-8 BOM）
 */
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

/**
 * 将数据导出为 Excel workbook
 */
async function toExcel(sheetName, headers, rows) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'OvO System';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(sheetName);

    // 表头样式
    sheet.columns = headers.map(h => ({
        header: h.label,
        key: h.key,
        width: h.width || 15
    }));

    // 添加数据行
    rows.forEach(row => {
        const rowData = {};
        headers.forEach(h => { rowData[h.key] = row[h.key] ?? ''; });
        sheet.addRow(rowData);
    });

    // 样式：表头加粗 + 背景色
    const headerRow = sheet.getRow(1);
    headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };
    });

    // 数据行交替色
    for (let i = 2; i <= rows.length + 1; i++) {
        const row = sheet.getRow(i);
        if (i % 2 === 0) {
            row.eachCell(cell => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
            });
        }
    }

    // 自动筛选
    if (rows.length > 0) {
        sheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: headers.length }
        };
    }

    return workbook;
}

/**
 * 根据 format 参数导出数据
 */
async function exportData(res, { name, sheetName, headers, rows, format }) {
    const ts = timestamp();

    if (format === 'json') {
        setDownloadHeaders(res, `${name}_${ts}.json`, 'application/json; charset=utf-8');
        // 转换为友好的 JSON 格式（使用中文标签作为键名）
        const jsonData = rows.map(row => {
            const obj = {};
            headers.forEach(h => { obj[h.label] = row[h.key] ?? ''; });
            return obj;
        });
        return res.send(JSON.stringify(jsonData, null, 2));
    }

    if (format === 'xlsx') {
        setDownloadHeaders(res, `${name}_${ts}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const workbook = await toExcel(sheetName, headers, rows);
        const buffer = await workbook.xlsx.writeBuffer();
        return res.send(Buffer.from(buffer));
    }

    // 默认 CSV
    setDownloadHeaders(res, `${name}_${ts}.csv`, 'text/csv; charset=utf-8');
    return res.send(toCSV(headers, rows));
}

// ===================== 导出路由 =====================

/**
 * GET /api/data/export/materials?format=csv|xlsx|json
 */
router.get('/export/materials', requirePermission('materials', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx' } = req.query;

    const rows = db.prepare(`
        SELECT m.code, m.name, c.name as category_name, m.spec, m.unit, m.brand,
               m.cost_price, m.sale_price, m.min_stock,
               COALESCE((SELECT SUM(i.quantity) FROM inventory i WHERE i.material_id = m.id), 0) as total_stock,
               m.notes, m.created_at
        FROM materials m
        LEFT JOIN categories c ON m.category_id = c.id
        WHERE m.is_active = 1
        ORDER BY m.code
    `).all();

    const headers = [
        { key: 'code',          label: '编码',   width: 20 },
        { key: 'name',          label: '名称',   width: 20 },
        { key: 'category_name', label: '分类',   width: 12 },
        { key: 'spec',          label: '规格',   width: 15 },
        { key: 'unit',          label: '单位',   width: 8 },
        { key: 'brand',         label: '品牌',   width: 12 },
        { key: 'cost_price',    label: '成本价', width: 10 },
        { key: 'sale_price',    label: '售价',   width: 10 },
        { key: 'min_stock',     label: '最低库存', width: 10 },
        { key: 'total_stock',   label: '当前库存', width: 10 },
        { key: 'notes',         label: '备注',   width: 25 },
        { key: 'created_at',    label: '创建时间', width: 18 }
    ];

    logOperation({ userId: req.session.user.id, action: 'export', resource: 'materials', detail: `导出物料数据(${format})，共 ${rows.length} 条`, ip: req.ip });
    await exportData(res, { name: '物料数据', sheetName: '物料列表', headers, rows, format });
}));

/**
 * GET /api/data/export/inventory?format=csv|xlsx|json
 */
router.get('/export/inventory', requirePermission('warehouses', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx' } = req.query;

    const rows = db.prepare(`
        SELECT m.code, m.name, m.spec, m.unit, c.name as category_name,
               w.name as warehouse_name, i.quantity,
               m.cost_price, ROUND(i.quantity * m.cost_price, 2) as stock_value,
               m.min_stock,
               CASE WHEN COALESCE((SELECT SUM(i2.quantity) FROM inventory i2 WHERE i2.material_id = m.id), 0) < m.min_stock THEN '是' ELSE '否' END as is_low
        FROM inventory i
        JOIN materials m ON i.material_id = m.id
        LEFT JOIN categories c ON m.category_id = c.id
        JOIN warehouses w ON i.warehouse_id = w.id
        WHERE m.is_active = 1 AND i.quantity > 0
        ORDER BY w.name, m.code
    `).all();

    const headers = [
        { key: 'code',           label: '物料编码',  width: 20 },
        { key: 'name',           label: '物料名称',  width: 20 },
        { key: 'category_name',  label: '分类',     width: 12 },
        { key: 'spec',           label: '规格',     width: 15 },
        { key: 'unit',           label: '单位',     width: 8 },
        { key: 'warehouse_name', label: '仓库',     width: 12 },
        { key: 'quantity',       label: '库存数量',  width: 10 },
        { key: 'cost_price',     label: '成本单价',  width: 10 },
        { key: 'stock_value',    label: '库存金额',  width: 12 },
        { key: 'min_stock',      label: '最低库存',  width: 10 },
        { key: 'is_low',         label: '低库存预警', width: 10 }
    ];

    logOperation({ userId: req.session.user.id, action: 'export', resource: 'inventory', detail: `导出库存数据(${format})，共 ${rows.length} 条`, ip: req.ip });
    await exportData(res, { name: '库存数据', sheetName: '库存明细', headers, rows, format });
}));

/**
 * GET /api/data/export/movements?format=csv|xlsx|json&startDate=&endDate=
 */
router.get('/export/movements', requirePermission('warehouses', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx', startDate, endDate } = req.query;

    let whereClauses = ['1=1'];
    let params = [];
    if (startDate) { whereClauses.push("sm.created_at >= ?"); params.push(startDate); }
    if (endDate) { whereClauses.push("sm.created_at <= ? || ' 23:59:59'"); params.push(endDate); }

    const rows = db.prepare(`
        SELECT sm.created_at, sm.type, m.code, m.name, m.spec, m.unit,
               w.name as warehouse_name, sm.quantity,
               sm.unit_price, sm.reference_no, sm.counterparty, sm.notes,
               u.display_name as operator
        FROM stock_movements sm
        JOIN materials m ON sm.material_id = m.id
        JOIN warehouses w ON sm.warehouse_id = w.id
        LEFT JOIN users u ON sm.created_by = u.id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY sm.created_at DESC
    `).all(...params);

    // 转换 type
    rows.forEach(r => { r.type_label = r.type === 'in' ? '入库' : '出库'; });

    const headers = [
        { key: 'created_at',     label: '时间',     width: 18 },
        { key: 'type_label',     label: '类型',     width: 8 },
        { key: 'code',           label: '物料编码',  width: 20 },
        { key: 'name',           label: '物料名称',  width: 20 },
        { key: 'spec',           label: '规格',     width: 15 },
        { key: 'unit',           label: '单位',     width: 8 },
        { key: 'warehouse_name', label: '仓库',     width: 12 },
        { key: 'quantity',       label: '数量',     width: 10 },
        { key: 'unit_price',     label: '单价',     width: 10 },
        { key: 'reference_no',   label: '参考单号',  width: 20 },
        { key: 'counterparty',   label: '往来单位',  width: 15 },
        { key: 'notes',          label: '备注',     width: 20 },
        { key: 'operator',       label: '操作人',   width: 10 }
    ];

    logOperation({ userId: req.session.user.id, action: 'export', resource: 'movements', detail: `导出出入库流水(${format})，共 ${rows.length} 条`, ip: req.ip });
    await exportData(res, { name: '出入库流水', sheetName: '出入库流水', headers, rows, format });
}));

/**
 * GET /api/data/export/shipments?format=csv|xlsx|json
 */
router.get('/export/shipments', requirePermission('shipments', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx' } = req.query;

    const statusMap = { pending: '待确认', confirmed: '已确认', shipped: '已发货', delivered: '已签收', cancelled: '已取消' };

    const rows = db.prepare(`
        SELECT s.shipment_no, s.status, s.customer_name, s.customer_contact, s.shipping_address,
               w.name as warehouse_name, s.total_amount,
               u.display_name as creator_name, s.created_at, s.notes,
               (SELECT GROUP_CONCAT(m.name || ' x' || si.quantity, '; ')
                FROM shipment_items si JOIN materials m ON si.material_id = m.id
                WHERE si.shipment_id = s.id) as items_summary
        FROM shipments s
        JOIN warehouses w ON s.warehouse_id = w.id
        LEFT JOIN users u ON s.created_by = u.id
        ORDER BY s.created_at DESC
    `).all();

    rows.forEach(r => { r.status_label = statusMap[r.status] || r.status; });

    const headers = [
        { key: 'shipment_no',     label: '发货单号',  width: 22 },
        { key: 'status_label',    label: '状态',     width: 10 },
        { key: 'customer_name',   label: '客户名称',  width: 15 },
        { key: 'customer_contact',label: '联系方式',  width: 15 },
        { key: 'shipping_address',label: '收货地址',  width: 25 },
        { key: 'warehouse_name',  label: '发货仓库',  width: 12 },
        { key: 'items_summary',   label: '物料明细',  width: 40 },
        { key: 'total_amount',    label: '总金额',   width: 12 },
        { key: 'creator_name',    label: '创建人',   width: 10 },
        { key: 'created_at',      label: '创建时间',  width: 18 },
        { key: 'notes',           label: '备注',     width: 20 }
    ];

    logOperation({ userId: req.session.user.id, action: 'export', resource: 'shipments', detail: `导出发货单(${format})，共 ${rows.length} 条`, ip: req.ip });
    await exportData(res, { name: '发货单', sheetName: '发货单', headers, rows, format });
}));

/**
 * GET /api/data/export/sops?format=csv|xlsx|json
 */
router.get('/export/sops', requirePermission('sops', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx' } = req.query;

    const rows = db.prepare(`
        SELECT s.title, s.version, s.category, s.description,
               (SELECT COUNT(*) FROM sop_steps st WHERE st.sop_id = s.id) as step_count,
               (SELECT COUNT(*) FROM sop_materials sm2 WHERE sm2.sop_id = s.id) as material_count,
               (SELECT COALESCE(SUM(sm3.quantity_per_unit * m3.cost_price), 0)
                FROM sop_materials sm3 JOIN materials m3 ON sm3.material_id = m3.id WHERE sm3.sop_id = s.id) as unit_cost,
               u.display_name as creator_name, s.created_at,
               (SELECT GROUP_CONCAT(st2.step_number || '. ' || st2.title, '; ')
                FROM sop_steps st2 WHERE st2.sop_id = s.id ORDER BY st2.step_number) as steps_summary,
               (SELECT GROUP_CONCAT(m4.name || ' x' || sm4.quantity_per_unit || m4.unit, '; ')
                FROM sop_materials sm4 JOIN materials m4 ON sm4.material_id = m4.id WHERE sm4.sop_id = s.id) as bom_summary
        FROM sops s
        LEFT JOIN users u ON s.created_by = u.id
        WHERE s.is_active = 1
        ORDER BY s.title
    `).all();

    const headers = [
        { key: 'title',         label: '标题',     width: 25 },
        { key: 'version',       label: '版本',     width: 8 },
        { key: 'category',      label: '分类',     width: 12 },
        { key: 'description',   label: '描述',     width: 30 },
        { key: 'step_count',    label: '步骤数',   width: 8 },
        { key: 'steps_summary', label: '步骤概要', width: 50 },
        { key: 'material_count',label: '物料种类',  width: 10 },
        { key: 'bom_summary',   label: 'BOM清单',  width: 50 },
        { key: 'unit_cost',     label: '单件成本',  width: 10 },
        { key: 'creator_name',  label: '创建人',   width: 10 },
        { key: 'created_at',    label: '创建时间',  width: 18 }
    ];

    logOperation({ userId: req.session.user.id, action: 'export', resource: 'sops', detail: `导出SOP(${format})，共 ${rows.length} 条`, ip: req.ip });
    await exportData(res, { name: 'SOP数据', sheetName: 'SOP列表', headers, rows, format });
}));

/**
 * GET /api/data/export/production?format=csv|xlsx|json
 */
router.get('/export/production', requirePermission('production', 'view'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx' } = req.query;

    const statusMap = { planned: '计划中', in_progress: '生产中', completed: '已完成', cancelled: '已取消' };

    const rows = db.prepare(`
        SELECT po.order_no, po.status, s.title as sop_title, s.version as sop_version,
               om.name as output_material_name, w.name as warehouse_name,
               po.planned_quantity, po.completed_quantity,
               u.display_name as creator_name,
               po.created_at, po.started_at, po.completed_at, po.notes
        FROM production_orders po
        LEFT JOIN sops s ON po.sop_id = s.id
        LEFT JOIN warehouses w ON po.warehouse_id = w.id
        LEFT JOIN users u ON po.created_by = u.id
        LEFT JOIN materials om ON po.output_material_id = om.id
        ORDER BY po.created_at DESC
    `).all();

    rows.forEach(r => {
        r.status_label = statusMap[r.status] || r.status;
        r.sop_info = `${r.sop_title || ''} v${r.sop_version || ''}`;
        r.progress = `${r.completed_quantity || 0}/${r.planned_quantity}`;
    });

    const headers = [
        { key: 'order_no',              label: '工单号',   width: 22 },
        { key: 'status_label',          label: '状态',    width: 10 },
        { key: 'sop_info',              label: 'SOP',    width: 25 },
        { key: 'output_material_name',  label: '产出物料', width: 18 },
        { key: 'warehouse_name',        label: '仓库',    width: 12 },
        { key: 'planned_quantity',      label: '计划数量', width: 10 },
        { key: 'completed_quantity',    label: '完成数量', width: 10 },
        { key: 'progress',             label: '进度',    width: 10 },
        { key: 'creator_name',         label: '创建人',   width: 10 },
        { key: 'created_at',           label: '创建时间', width: 18 },
        { key: 'started_at',           label: '开始时间', width: 18 },
        { key: 'completed_at',         label: '完成时间', width: 18 },
        { key: 'notes',                label: '备注',    width: 20 }
    ];

    logOperation({ userId: req.session.user.id, action: 'export', resource: 'production', detail: `导出生产工单(${format})，共 ${rows.length} 条`, ip: req.ip });
    await exportData(res, { name: '生产工单', sheetName: '生产工单', headers, rows, format });
}));

// ===================== 导入模板下载 =====================

/**
 * GET /api/data/import/materials/template?format=csv|xlsx
 */
router.get('/import/materials/template', requirePermission('materials', 'add'), asyncHandler(async (req, res) => {
    const db = getDB();
    const { format = 'xlsx' } = req.query;

    const headers = [
        { key: 'name',       label: '名称（必填）',  width: 20 },
        { key: 'code',       label: '编码（留空自动生成）', width: 22 },
        { key: 'category',   label: '分类名称',     width: 15 },
        { key: 'spec',       label: '规格',         width: 15 },
        { key: 'unit',       label: '单位（必填）',  width: 10 },
        { key: 'brand',      label: '品牌',         width: 12 },
        { key: 'cost_price', label: '成本价',       width: 10 },
        { key: 'sale_price', label: '售价',         width: 10 },
        { key: 'min_stock',  label: '最低库存',     width: 10 },
        { key: 'notes',      label: '备注',         width: 25 }
    ];

    // 示例数据
    const sampleRows = [
        { name: '电阻100Ω', code: '', category: '电子元件', spec: '0603 ±1%', unit: '个', brand: '', cost_price: 0.01, sale_price: 0.05, min_stock: 1000, notes: '示例数据，请删除' },
        { name: '铝合金外壳', code: '', category: '结构件', spec: '100x60x25mm', unit: '个', brand: 'Maverick', cost_price: 15.00, sale_price: 30.00, min_stock: 50, notes: '示例数据，请删除' }
    ];

    if (format === 'xlsx') {
        const workbook = await toExcel('物料导入模板', headers, sampleRows);
        // 添加说明sheet
        const helpSheet = workbook.addWorksheet('填写说明');
        helpSheet.columns = [
            { header: '字段', key: 'field', width: 25 },
            { header: '说明', key: 'desc', width: 50 },
            { header: '是否必填', key: 'required', width: 12 }
        ];
        const helpRow = helpSheet.getRow(1);
        helpRow.eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
        });
        helpSheet.addRows([
            { field: '名称', desc: '物料名称，不可为空', required: '是' },
            { field: '编码', desc: '物料编码，留空则按 MAT-日期-序号 自动生成', required: '否' },
            { field: '分类名称', desc: '已有分类名称，不存在则自动创建', required: '否' },
            { field: '规格', desc: '物料规格型号', required: '否' },
            { field: '单位', desc: '计量单位（如 个、块、米、kg），不可为空', required: '是' },
            { field: '品牌', desc: '品牌名称', required: '否' },
            { field: '成本价', desc: '数字，小数点后最多2位', required: '否' },
            { field: '售价', desc: '数字，小数点后最多2位', required: '否' },
            { field: '最低库存', desc: '整数，低于此值触发预警，默认0', required: '否' },
            { field: '备注', desc: '附加说明', required: '否' }
        ]);

        // 获取现有分类列表添加到说明
        const cats = db.prepare('SELECT name FROM categories ORDER BY name').all();
        if (cats.length > 0) {
            helpSheet.addRow({});
            helpSheet.addRow({ field: '现有分类列表：', desc: cats.map(c => c.name).join('、'), required: '' });
        }

        setDownloadHeaders(res, '物料导入模板.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const buffer = await workbook.xlsx.writeBuffer();
        return res.send(Buffer.from(buffer));
    }

    // CSV 模板
    setDownloadHeaders(res, '物料导入模板.csv', 'text/csv; charset=utf-8');
    res.send(toCSV(headers, sampleRows));
}));

// ===================== 导入路由 =====================

/**
 * POST /api/data/import/materials
 * 支持 CSV / XLSX / JSON 文件上传
 */
router.post('/import/materials', requirePermission('materials', 'add'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('请选择要导入的文件');

    const ext = path.extname(req.file.originalname).toLowerCase();
    let records = [];

    try {
        if (ext === '.csv') {
            records = parseCSV(req.file.buffer.toString('utf-8'));
        } else if (ext === '.xlsx' || ext === '.xls') {
            records = await parseExcel(req.file.buffer);
        } else if (ext === '.json') {
            records = parseJSON(req.file.buffer.toString('utf-8'));
        }
    } catch (err) {
        throw new ValidationError(`文件解析失败: ${err.message}`);
    }

    if (records.length === 0) {
        throw new ValidationError('文件中没有有效数据');
    }
    if (records.length > 500) {
        throw new ValidationError('单次导入最多支持500条数据');
    }

    const db = getDB();
    const results = { success: 0, skipped: 0, errors: [] };

    // 预处理：建立分类映射
    const categoryCache = {};
    db.prepare('SELECT id, name FROM categories').all()
        .forEach(c => { categoryCache[c.name.toLowerCase()] = c.id; });

    // 预处理：已有编码集合
    const existingCodes = new Set(
        db.prepare('SELECT code FROM materials').all().map(m => m.code)
    );

    // 自动编码生成器
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let lastCodeSeq = db.prepare(
        "SELECT code FROM materials WHERE code LIKE ? ORDER BY code DESC LIMIT 1"
    ).get(`MAT-${today}-%`);
    let codeSeq = lastCodeSeq ? parseInt(lastCodeSeq.code.split('-')[2]) + 1 : 1;

    const insertMaterial = db.transaction(() => {
        for (let i = 0; i < records.length; i++) {
            const row = records[i];
            const rowNum = i + 2; // +2 因为 1 是表头

            try {
                // 清理字段
                const name = (row.name || row['名称'] || row['名称（必填）'] || '').toString().trim();
                const unit = (row.unit || row['单位'] || row['单位（必填）'] || '').toString().trim();

                if (!name) { results.errors.push({ row: rowNum, error: '名称不能为空' }); results.skipped++; continue; }
                if (!unit) { results.errors.push({ row: rowNum, error: '单位不能为空' }); results.skipped++; continue; }

                let code = (row.code || row['编码'] || row['编码（留空自动生成）'] || '').toString().trim();
                const categoryName = (row.category || row['分类名称'] || row['分类'] || '').toString().trim();
                const spec = (row.spec || row['规格'] || '').toString().trim();
                const brand = (row.brand || row['品牌'] || '').toString().trim();
                const costPrice = parseFloat(row.cost_price || row['成本价'] || 0) || 0;
                const salePrice = parseFloat(row.sale_price || row['售价'] || 0) || 0;
                const minStock = parseInt(row.min_stock || row['最低库存'] || 0) || 0;
                const notes = (row.notes || row['备注'] || '').toString().trim();

                // 去重检查：按编码或名称
                if (code && existingCodes.has(code)) {
                    results.errors.push({ row: rowNum, error: `编码 "${code}" 已存在` });
                    results.skipped++;
                    continue;
                }

                // 自动生成编码
                if (!code) {
                    code = `MAT-${today}-${String(codeSeq++).padStart(3, '0')}`;
                    while (existingCodes.has(code)) {
                        code = `MAT-${today}-${String(codeSeq++).padStart(3, '0')}`;
                    }
                }

                // 处理分类
                let categoryId = null;
                if (categoryName) {
                    const catKey = categoryName.toLowerCase();
                    if (categoryCache[catKey]) {
                        categoryId = categoryCache[catKey];
                    } else {
                        // 自动创建分类
                        const result = db.prepare('INSERT INTO categories (name) VALUES (?)').run(categoryName);
                        categoryId = result.lastInsertRowid;
                        categoryCache[catKey] = categoryId;
                    }
                }

                // 拼音
                const { fullPinyin, abbr } = generatePinyinFields(name);

                // 插入
                db.prepare(`
                    INSERT INTO materials (code, name, name_pinyin, name_pinyin_abbr, category_id, spec, unit, brand, cost_price, sale_price, min_stock, notes)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(code, name, fullPinyin, abbr, categoryId, spec || null, unit, brand || null, costPrice, salePrice, minStock, notes || null);

                existingCodes.add(code);
                results.success++;
            } catch (err) {
                results.errors.push({ row: rowNum, error: err.message });
                results.skipped++;
            }
        }
    });

    insertMaterial();

    logOperation({
        userId: req.session.user.id, action: 'import', resource: 'materials',
        detail: `批量导入物料：成功 ${results.success}，跳过 ${results.skipped}，共 ${records.length} 条`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            total: records.length,
            imported: results.success,
            skipped: results.skipped,
            errors: results.errors.slice(0, 20) // 最多返回20条错误
        }
    });
}));

// ===================== 文件解析函数 =====================

/**
 * 解析 CSV 内容
 */
function parseCSV(content) {
    // 去除 BOM
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

    const lines = content.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) return [];

    // 解析表头
    const headers = parseCSVLine(lines[0]);

    // 解析数据行
    const records = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.every(v => !v.trim())) continue; // 跳过空行

        const record = {};
        headers.forEach((h, idx) => {
            record[h.trim()] = (values[idx] || '').trim();
        });
        records.push(record);
    }
    return records;
}

/**
 * 解析 CSV 行（处理引号转义）
 */
function parseCSVLine(line) {
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
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
    }
    result.push(current);
    return result;
}

/**
 * 解析 Excel 文件
 */
async function parseExcel(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet = workbook.worksheets[0]; // 取第一个工作表
    if (!sheet || sheet.rowCount < 2) return [];

    const headers = [];
    sheet.getRow(1).eachCell((cell, colNumber) => {
        headers[colNumber] = cell.value?.toString().trim() || `col${colNumber}`;
    });

    const records = [];
    for (let i = 2; i <= sheet.rowCount; i++) {
        const row = sheet.getRow(i);
        const record = {};
        let hasValue = false;
        headers.forEach((h, colNumber) => {
            if (!h) return;
            let val = row.getCell(colNumber).value;
            if (val && typeof val === 'object' && val.result !== undefined) val = val.result; // 公式
            if (val && typeof val === 'object' && val.text) val = val.text; // 富文本
            record[h] = val ?? '';
            if (val) hasValue = true;
        });
        if (hasValue) records.push(record);
    }
    return records;
}

/**
 * 解析 JSON 文件
 */
function parseJSON(content) {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data;
    if (data.data && Array.isArray(data.data)) return data.data;
    throw new Error('JSON 文件格式不正确，需要是数组格式');
}

module.exports = router;
