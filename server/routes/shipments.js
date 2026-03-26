/**
 * 发货管理路由
 * GET    /api/shipments              - 发货单列表
 * POST   /api/shipments              - 创建发货单（含库存校验）
 * GET    /api/shipments/:id          - 发货单详情
 * PUT    /api/shipments/:id/status   - 更新发货单状态
 * DELETE /api/shipments/:id          - 取消发货单
 */

const express = require('express');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { logOperation } = require('../utils/logger');
const {
    createDocument,
    submitDocument,
    executeDocument,
    postDocument,
    reverseDocument,
    discardDraftDocument,
    voidDocument,
    getDocumentById
} = require('../services/stockDocuments');

const router = express.Router();
router.use(requireAuth);

/**
 * 生成发货单号 SH-YYYYMMDD-NNN
 */
function generateShipmentNo(db) {
    const today = new Date();
    const dateStr = today.getFullYear().toString() +
        String(today.getMonth() + 1).padStart(2, '0') +
        String(today.getDate()).padStart(2, '0');
    const prefix = `SH-${dateStr}-`;
    const last = db.prepare(
        "SELECT shipment_no FROM shipments WHERE shipment_no LIKE ? ORDER BY shipment_no DESC LIMIT 1"
    ).get(`${prefix}%`);
    let seq = 1;
    if (last) {
        const lastSeq = parseInt(last.shipment_no.split('-').pop(), 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    return `${prefix}${String(seq).padStart(3, '0')}`;
}

function buildShipmentDocumentPayload(db, shipmentNo, payload) {
    return {
        docType: 'shipment_execution',
        warehouseId: Number(payload.warehouseId),
        counterparty: payload.customerName || null,
        referenceNo: shipmentNo,
        notes: payload.notes || null,
        items: payload.items.map(item => {
            const material = db.prepare('SELECT sale_price FROM materials WHERE id = ?').get(item.materialId);
            const unitPrice = item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== ''
                ? Number(item.unitPrice)
                : Number(material?.sale_price || 0);
            return {
                materialId: Number(item.materialId),
                quantity: Number(item.quantity),
                unitPrice,
                notes: item.notes || null
            };
        })
    };
}

function getShipmentDocumentOrThrow(db, shipment) {
    if (!shipment.stock_document_id) {
        throw new ConflictError('当前发货单尚未关联正式库存单据');
    }
    return getDocumentById(db, shipment.stock_document_id);
}

function syncShipmentStatusWithDocument(db, shipment, targetStatus, userId) {
    const document = getShipmentDocumentOrThrow(db, shipment);

    if (targetStatus === 'confirmed') {
        if (document.documentStatus !== 'draft') throw new ConflictError('只有草稿库存单据允许确认待发');
        submitDocument(db, document.id, userId);
        return;
    }

    if (targetStatus === 'shipped') {
        if (document.documentStatus === 'draft') {
            submitDocument(db, document.id, userId);
        }
        const latest = getDocumentById(db, document.id);
        if (latest.documentStatus !== 'submitted') throw new ConflictError('只有已提交库存单据允许执行发货');
        executeDocument(db, latest.id, userId);
        postDocument(db, latest.id, userId);
        return;
    }

    if (targetStatus === 'cancelled') {
        if (document.documentStatus === 'draft') {
            discardDraftDocument(db, document.id, userId, 'shipment_cancelled');
            return;
        }
        if (document.documentStatus === 'submitted') {
            voidDocument(db, document.id, userId, 'shipment_cancelled');
            return;
        }
        if (document.documentStatus === 'posted') {
            reverseDocument(db, document.id, userId, 'shipment_cancelled');
            return;
        }
        throw new ConflictError('当前库存单据状态不允许取消发货');
    }
}

function shipmentStatusLabel(status) {
    return ({ pending: '待确认', confirmed: '待发出', shipped: '已发出', delivered: '已签收', cancelled: '已取消' })[status] || status;
}

function documentStatusLabel(status) {
    return ({ draft: '草稿', submitted: '已提交', executed: '已执行', posted: '已记账', voided: '已作废' })[status] || status;
}

/**
 * GET /api/shipments
 */
router.get('/', requirePermission('shipments', 'view'), (req, res) => {
    const db = getDB();
    const { status = '', page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageSize;

    const conditions = [];
    const params = [];
    if (status) {
        conditions.push('s.status = ?');
        params.push(status);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = db.prepare(
        `SELECT COUNT(*) as total FROM shipments s ${whereClause}`
    ).get(...params);

    const shipments = db.prepare(`
        SELECT s.*, w.name as warehouse_name, u.display_name as creator_name,
               sd.doc_no as document_no, sd.status as document_status,
               (SELECT COUNT(*) FROM shipment_items si WHERE si.shipment_id = s.id) as item_count
        FROM shipments s
        JOIN warehouses w ON s.warehouse_id = w.id
        LEFT JOIN users u ON s.created_by = u.id
        LEFT JOIN stock_documents sd ON s.stock_document_id = sd.id
        ${whereClause}
        ORDER BY s.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({
        success: true,
        data: {
            shipments,
            pagination: { page: pageNum, limit: pageSize, total: countRow.total, totalPages: Math.ceil(countRow.total / pageSize) }
        }
    });
});

/**
 * GET /api/shipments/:id
 */
router.get('/:id', requirePermission('shipments', 'view'), (req, res) => {
    const db = getDB();
    const shipment = db.prepare(`
        SELECT s.*, w.name as warehouse_name, u.display_name as creator_name,
               sd.doc_no as document_no, sd.status as document_status
        FROM shipments s
        JOIN warehouses w ON s.warehouse_id = w.id
        LEFT JOIN users u ON s.created_by = u.id
        LEFT JOIN stock_documents sd ON s.stock_document_id = sd.id
        WHERE s.id = ?
    `).get(req.params.id);
    if (!shipment) throw new NotFoundError('发货单');

    const items = db.prepare(`
        SELECT si.*, m.code as material_code, m.name as material_name, m.unit, m.spec
        FROM shipment_items si
        JOIN materials m ON si.material_id = m.id
        WHERE si.shipment_id = ?
    `).all(req.params.id);

    const stockDocument = shipment.stock_document_id ? getDocumentById(db, shipment.stock_document_id) : null;

    res.json({ success: true, data: { shipment, items, stockDocument } });
});

/**
 * POST /api/shipments/check-stock
 * 预检查库存是否充足（创建发货单前调用）
 */
router.post('/check-stock', requirePermission('shipments', 'add'), (req, res) => {
    const { warehouseId, items } = req.body;
    if (!warehouseId) throw new ValidationError('请选择仓库');
    if (!items || !items.length) throw new ValidationError('请添加物料');

    const db = getDB();
    const results = [];
    let allSufficient = true;

    for (const item of items) {
        const material = db.prepare('SELECT id, name, unit FROM materials WHERE id = ?').get(item.materialId);
        if (!material) continue;

        const inv = db.prepare(
            'SELECT quantity FROM inventory WHERE material_id = ? AND warehouse_id = ?'
        ).get(item.materialId, warehouseId);
        const available = inv ? inv.quantity : 0;
        const sufficient = available >= item.quantity;
        if (!sufficient) allSufficient = false;

        results.push({
            materialId: item.materialId,
            materialName: material.name,
            unit: material.unit,
            requested: item.quantity,
            available,
            sufficient,
            shortage: sufficient ? 0 : item.quantity - available
        });
    }

    res.json({ success: true, data: { allSufficient, items: results } });
});

/**
 * POST /api/shipments
 * 创建发货单（事务：创建经营单据 + 正式库存单据草稿）
 */
router.post('/', requirePermission('shipments', 'add'), (req, res) => {
    const { warehouseId, customerName, customerContact, shippingAddress, items, notes } = req.body;

    if (!warehouseId) throw new ValidationError('请选择仓库', 'warehouseId');
    if (!items || !items.length) throw new ValidationError('请至少添加一个物料');

    // 验证每个物料
    for (const item of items) {
        if (!item.materialId) throw new ValidationError('物料不能为空');
        if (!item.quantity || item.quantity <= 0) throw new ValidationError('数量必须大于0');
    }

    const db = getDB();

    // 验证仓库
    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId);
    if (!warehouse) throw new NotFoundError('仓库');

    // 检查所有物料库存
    const stockErrors = [];
    for (const item of items) {
        const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_active = 1').get(item.materialId);
        if (!material) throw new NotFoundError(`物料 ID ${item.materialId}`);

        const inv = db.prepare(
            'SELECT quantity FROM inventory WHERE material_id = ? AND warehouse_id = ?'
        ).get(item.materialId, warehouseId);
        const available = inv ? inv.quantity : 0;

        if (available < item.quantity) {
            stockErrors.push(`${material.name}: 库存 ${available} ${material.unit}，需要 ${item.quantity} ${material.unit}，缺口 ${item.quantity - available}`);
        }
    }
    if (stockErrors.length > 0) {
        throw new ValidationError('库存不足:\n' + stockErrors.join('\n'));
    }

    // 事务：创建发货单 + 关联库存单据草稿
    let totalAmount = 0;

    const doCreate = db.transaction(() => {
        const shipmentNo = generateShipmentNo(db);
        const documentPayload = buildShipmentDocumentPayload(db, shipmentNo, req.body);
        const document = createDocument(db, documentPayload, req.session.user.id, 'draft');

        // 创建发货单
        const result = db.prepare(`
            INSERT INTO shipments (shipment_no, customer_name, customer_contact, shipping_address, warehouse_id, stock_document_id, status, notes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(shipmentNo, customerName || null, customerContact || null, shippingAddress || null, warehouseId, document.id, notes || null, req.session.user.id);

        const shipmentId = result.lastInsertRowid;

        // 插入明细
        for (const item of items) {
            const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(item.materialId);
            const unitPrice = item.unitPrice || material.sale_price || 0;
            const itemTotal = unitPrice * item.quantity;
            totalAmount += itemTotal;

            // 插入发货明细
            db.prepare(`
                INSERT INTO shipment_items (shipment_id, material_id, quantity, unit_price, total_price)
                VALUES (?, ?, ?, ?, ?)
            `).run(shipmentId, item.materialId, item.quantity, unitPrice, itemTotal);
        }

        // 更新总金额
        db.prepare('UPDATE shipments SET total_amount = ? WHERE id = ?').run(totalAmount, shipmentId);

        return { shipmentId, shipmentNo, stockDocumentId: document.id };
    });

    const { shipmentId, shipmentNo, stockDocumentId } = doCreate();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'shipments',
        resourceId: shipmentId,
        detail: `创建发货单 ${shipmentNo}，关联库存单据 #${stockDocumentId}，共 ${items.length} 种物料，金额 ¥${totalAmount.toFixed(2)}`,
        ip: req.ip
    });

    res.status(201).json({
        success: true,
        data: { id: shipmentId, shipmentNo, totalAmount, stockDocumentId }
    });
});

/**
 * PUT /api/shipments/:id/status
 * 更新发货单状态
 */
router.put('/:id/status', requirePermission('shipments', 'edit'), (req, res) => {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) throw new ValidationError('无效的状态');

    const db = getDB();
    const shipment = db.prepare('SELECT * FROM shipments WHERE id = ?').get(req.params.id);
    if (!shipment) throw new NotFoundError('发货单');

    // 状态转换合法性检查
    const validTransitions = {
        pending: ['confirmed', 'cancelled'],
        confirmed: ['shipped', 'cancelled'],
        shipped: ['delivered', 'cancelled'],
        delivered: [],
        cancelled: []
    };
    if (!validTransitions[shipment.status]?.includes(status)) {
        throw new ValidationError(`无法从"${shipment.status}"变更为"${status}"`);
    }

    const runUpdate = db.transaction(() => {
        if (status !== 'delivered') {
            syncShipmentStatusWithDocument(db, shipment, status, req.session.user.id);
        }

        db.prepare(`
            UPDATE shipments SET status = ?,
                shipped_at = CASE WHEN ? = 'shipped' THEN datetime('now', 'localtime') ELSE shipped_at END,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(status, status, req.params.id);
    });
    runUpdate();

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'shipments',
        resourceId: Number(req.params.id),
        detail: `发货单 ${shipment.shipment_no} 状态更新为: ${shipmentStatusLabel(status)}`,
        ip: req.ip
    });

    const latestShipment = db.prepare(`
        SELECT s.*, sd.doc_no as document_no, sd.status as document_status
        FROM shipments s
        LEFT JOIN stock_documents sd ON s.stock_document_id = sd.id
        WHERE s.id = ?
    `).get(req.params.id);

    res.json({
        success: true,
        message: `状态已更新为: ${shipmentStatusLabel(status)}`,
        data: {
            shipment: latestShipment,
            documentStatusLabel: latestShipment?.document_status ? documentStatusLabel(latestShipment.document_status) : null
        }
    });
});

module.exports = router;
