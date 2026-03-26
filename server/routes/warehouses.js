/**
 * 仓库管理路由
 * GET    /api/warehouses          - 仓库列表
 * POST   /api/warehouses          - 创建仓库
 * GET    /api/warehouses/:id      - 仓库详情（含库存）
 * PUT    /api/warehouses/:id      - 修改仓库
 * DELETE /api/warehouses/:id      - 删除仓库
 * GET    /api/warehouses/:id/inventory - 仓库库存明细
 * POST   /api/warehouses/:id/stock-in  - 入库操作
 * POST   /api/warehouses/:id/stock-out - 出库操作
 * GET    /api/warehouses/:id/materials/:materialId/stock - 指定物料库存快照
 * POST   /api/warehouses/:id/stock-adjust - 盘点/库存调整
 * POST   /api/warehouses/transfer      - 仓库间调拨
 */

const express = require('express');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permission');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { generatePinyinFields, buildSearchCondition } = require('../utils/pinyin');
const { logOperation } = require('../utils/logger');
const { getAvailable } = require('../services/inventory');
const {
    createDocument,
    executeDocument,
    postDocument
} = require('../services/stockDocuments');

const router = express.Router();

router.use(requireAuth);

function createPostedDocumentFromLegacyPayload(db, payload, userId) {
    const created = createDocument(db, payload, userId, 'submitted');
    executeDocument(db, created.id, userId);
    return postDocument(db, created.id, userId);
}

/**
 * GET /api/warehouses
 * 仓库列表
 */
router.get('/', requirePermission('warehouses', 'view'), (req, res) => {
    const db = getDB();
    const { q = '', active = '1' } = req.query;

    const conditions = [];
    const params = [];

    if (q.trim()) {
        const search = buildSearchCondition(q);
        conditions.push(search.where);
        params.push(...search.params);
    }

    if (active !== '') {
        conditions.push('w.is_active = ?');
        params.push(parseInt(active, 10));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const warehouses = db.prepare(`
        SELECT w.*,
            COUNT(DISTINCT i.material_id) as material_types,
            COALESCE(SUM(i.quantity), 0) as total_quantity
        FROM warehouses w
        LEFT JOIN inventory i ON w.id = i.warehouse_id AND i.quantity > 0
        ${whereClause}
        GROUP BY w.id
        ORDER BY w.created_at ASC
    `).all(...params);

    res.json({ success: true, data: { warehouses } });
});

/**
 * GET /api/warehouses/:id
 * 仓库详情
 */
router.get('/:id', requirePermission('warehouses', 'view'), (req, res) => {
    const db = getDB();
    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.params.id);
    if (!warehouse) throw new NotFoundError('仓库');

    // 该仓库的库存概况
    const stats = db.prepare(`
        SELECT
            COUNT(DISTINCT material_id) as material_types,
            COALESCE(SUM(quantity), 0) as total_quantity
        FROM inventory
        WHERE warehouse_id = ? AND quantity > 0
    `).get(req.params.id);

    res.json({
        success: true,
        data: { warehouse, stats }
    });
});

/**
 * GET /api/warehouses/:id/inventory
 * 仓库库存明细
 */
router.get('/:id/inventory', requirePermission('warehouses', 'view'), (req, res) => {
    const db = getDB();
    const { q = '', page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageSize;

    let searchWhere = '';
    const params = [req.params.id];

    if (q.trim()) {
        const search = buildSearchCondition(q, { codeField: 'm.code' });
        // 需要给字段加表前缀
        const prefixedWhere = search.where
            .replace(/\bname\b/g, 'm.name')
            .replace(/\bname_pinyin\b/g, 'm.name_pinyin')
            .replace(/\bname_pinyin_abbr\b/g, 'm.name_pinyin_abbr');
        searchWhere = `AND ${prefixedWhere}`;
        params.push(...search.params);
    }

    const countRow = db.prepare(`
        SELECT COUNT(*) as total
        FROM inventory i
        JOIN materials m ON i.material_id = m.id
        WHERE i.warehouse_id = ? AND i.quantity > 0 ${searchWhere}
    `).get(...params);

    const items = db.prepare(`
        SELECT i.*, m.code, m.name, m.unit, m.spec, m.brand, m.min_stock,
               m.cost_price, m.sale_price, c.name as category_name
        FROM inventory i
        JOIN materials m ON i.material_id = m.id
        LEFT JOIN categories c ON m.category_id = c.id
        WHERE i.warehouse_id = ? AND i.quantity > 0 ${searchWhere}
        ORDER BY m.name
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    res.json({
        success: true,
        data: {
            items,
            pagination: {
                page: pageNum,
                limit: pageSize,
                total: countRow.total,
                totalPages: Math.ceil(countRow.total / pageSize)
            }
        }
    });
});

/**
 * GET /api/warehouses/:id/materials/:materialId/stock
 * 指定物料在指定仓库的库存快照
 */
router.get('/:id/materials/:materialId/stock', requirePermission('warehouses', 'view'), (req, res) => {
    const db = getDB();
    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!warehouse) throw new NotFoundError('仓库');

    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_active = 1').get(req.params.materialId);
    if (!material) throw new NotFoundError('物料');

    const quantity = getAvailable(db, req.params.materialId, req.params.id);

    res.json({
        success: true,
        data: {
            warehouse: { id: warehouse.id, name: warehouse.name },
            material: { id: material.id, code: material.code, name: material.name, unit: material.unit },
            quantity
        }
    });
});

/**
 * POST /api/warehouses
 * 创建仓库
 */
router.post('/', requirePermission('warehouses', 'add'), (req, res) => {
    const { name, address, contactPerson, contactPhone, notes } = req.body;

    if (!name || !name.trim()) throw new ValidationError('请输入仓库名称', 'name');

    const db = getDB();
    const { fullPinyin, abbr } = generatePinyinFields(name.trim());

    const result = db.prepare(`
        INSERT INTO warehouses (name, name_pinyin, name_pinyin_abbr, address, contact_person, contact_phone, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name.trim(), fullPinyin, abbr, address || null, contactPerson || null, contactPhone || null, notes || null);

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'warehouses',
        resourceId: result.lastInsertRowid,
        detail: `创建仓库: ${name}`,
        ip: req.ip
    });

    res.status(201).json({
        success: true,
        data: { id: result.lastInsertRowid, name: name.trim() }
    });
});

/**
 * PUT /api/warehouses/:id
 * 修改仓库
 */
router.put('/:id', requirePermission('warehouses', 'edit'), (req, res) => {
    const { name, address, contactPerson, contactPhone, notes } = req.body;
    const db = getDB();

    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.params.id);
    if (!warehouse) throw new NotFoundError('仓库');

    const finalName = name?.trim() || warehouse.name;
    let py = { fullPinyin: warehouse.name_pinyin, abbr: warehouse.name_pinyin_abbr };
    if (name && name.trim() !== warehouse.name) {
        py = generatePinyinFields(finalName);
    }

    db.prepare(`
        UPDATE warehouses SET
            name = ?, name_pinyin = ?, name_pinyin_abbr = ?,
            address = ?, contact_person = ?, contact_phone = ?, notes = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(
        finalName, py.fullPinyin, py.abbr,
        address !== undefined ? address : warehouse.address,
        contactPerson !== undefined ? contactPerson : warehouse.contact_person,
        contactPhone !== undefined ? contactPhone : warehouse.contact_phone,
        notes !== undefined ? notes : warehouse.notes,
        req.params.id
    );

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'warehouses',
        resourceId: Number(req.params.id),
        detail: `修改仓库: ${finalName}`,
        ip: req.ip
    });

    res.json({ success: true, message: '仓库信息已更新' });
});

/**
 * DELETE /api/warehouses/:id
 * 删除仓库（软删除）
 */
router.delete('/:id', requirePermission('warehouses', 'delete'), (req, res) => {
    const db = getDB();
    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(req.params.id);
    if (!warehouse) throw new NotFoundError('仓库');

    // 检查是否有库存
    const stock = db.prepare(
        'SELECT SUM(quantity) as total FROM inventory WHERE warehouse_id = ?'
    ).get(req.params.id);
    if (stock && stock.total > 0) {
        throw new ValidationError('该仓库还有库存，请先清空后再删除');
    }

    db.prepare(
        "UPDATE warehouses SET is_active = 0, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(req.params.id);

    logOperation({
        userId: req.session.user.id,
        action: 'delete',
        resource: 'warehouses',
        resourceId: Number(req.params.id),
        detail: `删除仓库: ${warehouse.name}`,
        ip: req.ip
    });

    res.json({ success: true, message: '仓库已删除' });
});

/**
 * POST /api/warehouses/:id/stock-in
 * 入库操作
 */
router.post('/:id/stock-in', requirePermission('receive', 'edit'), (req, res) => {
    const { materialId, quantity, unitPrice, counterparty, referenceNo, notes } = req.body;
    const warehouseId = req.params.id;

    if (!materialId) throw new ValidationError('请选择物料', 'materialId');
    if (!quantity || quantity <= 0) throw new ValidationError('数量必须大于0', 'quantity');

    const db = getDB();

    // 验证仓库和物料存在
    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId);
    if (!warehouse) throw new NotFoundError('仓库');
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_active = 1').get(materialId);
    if (!material) throw new NotFoundError('物料');
    const document = db.transaction(() => createPostedDocumentFromLegacyPayload(db, {
        docType: 'receive_execution',
        warehouseId: Number(warehouseId),
        counterparty,
        referenceNo,
        notes,
        items: [{
            materialId: Number(materialId),
            quantity: Number(quantity),
            unitPrice: unitPrice !== undefined && unitPrice !== null && unitPrice !== '' ? Number(unitPrice) : null
        }]
    }, req.session.user.id))();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'warehouses',
        resourceId: Number(warehouseId),
        detail: `入库: ${material.name} × ${quantity} → ${warehouse.name}`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            document: {
                ...document,
                sourceLabel: '手工收货 / 回库'
            }
        },
        message: `${material.name} × ${quantity} 已通过新单据入口完成入库`
    });
});

/**
 * POST /api/warehouses/:id/stock-out
 * 出库操作
 */
router.post('/:id/stock-out', requirePermission('issue', 'edit'), (req, res) => {
    const { materialId, quantity, unitPrice, counterparty, referenceNo, notes } = req.body;
    const warehouseId = req.params.id;

    if (!materialId) throw new ValidationError('请选择物料', 'materialId');
    if (!quantity || quantity <= 0) throw new ValidationError('数量必须大于0', 'quantity');

    const db = getDB();

    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId);
    if (!warehouse) throw new NotFoundError('仓库');
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_active = 1').get(materialId);
    if (!material) throw new NotFoundError('物料');
    const document = db.transaction(() => createPostedDocumentFromLegacyPayload(db, {
        docType: 'issue_execution',
        warehouseId: Number(warehouseId),
        counterparty,
        referenceNo,
        notes,
        items: [{
            materialId: Number(materialId),
            quantity: Number(quantity),
            unitPrice: unitPrice !== undefined && unitPrice !== null && unitPrice !== '' ? Number(unitPrice) : null
        }]
    }, req.session.user.id))();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'warehouses',
        resourceId: Number(warehouseId),
        detail: `出库: ${material.name} × ${quantity} ← ${warehouse.name}`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            document: {
                ...document,
                sourceLabel: '手工发料 / 出库'
            }
        },
        message: `${material.name} × ${quantity} 已通过新单据入口完成出库`
    });
});

/**
 * POST /api/warehouses/:id/stock-adjust
 * 盘点/库存调整
 */
router.post('/:id/stock-adjust', requirePermission('count', 'edit'), (req, res) => {
    const { materialId, actualQuantity, referenceNo, counterparty, notes } = req.body;
    const warehouseId = req.params.id;

    if (!materialId) throw new ValidationError('请选择物料', 'materialId');
    if (actualQuantity === undefined || actualQuantity === null || Number.isNaN(Number(actualQuantity))) {
        throw new ValidationError('请输入实际数量', 'actualQuantity');
    }

    const db = getDB();

    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId);
    if (!warehouse) throw new NotFoundError('仓库');
    const material = db.prepare('SELECT * FROM materials WHERE id = ? AND is_active = 1').get(materialId);
    if (!material) throw new NotFoundError('物料');
    const normalizedActualQuantity = Number(actualQuantity);
    const beforeQuantity = getAvailable(db, materialId, warehouseId);
    const document = db.transaction(() => createPostedDocumentFromLegacyPayload(db, {
        docType: 'count_execution',
        warehouseId: Number(warehouseId),
        counterparty,
        referenceNo,
        notes,
        items: [{
            materialId: Number(materialId),
            actualQuantity: normalizedActualQuantity
        }]
    }, req.session.user.id))();
    const deltaPrefix = Number(document.delta || 0) > 0 ? '+' : '';

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'warehouses',
        resourceId: Number(warehouseId),
        detail: `库存调整: ${material.name} ${warehouse.name} ${beforeQuantity} → ${normalizedActualQuantity} (${deltaPrefix}${document.delta || 0})`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            beforeQuantity: document.beforeQuantity,
            actualQuantity: document.actualQuantity,
            delta: document.delta,
            document: {
                ...document,
                sourceLabel: '盘点调整'
            }
        },
        message: `${material.name} 库存已通过新单据入口调整为 ${document.actualQuantity}`
    });
});

/**
 * POST /api/warehouses/transfer
 * 仓库间调拨
 */
router.post('/transfer', requirePermission('transfer', 'edit'), (req, res) => {
    const { materialId, fromWarehouseId, toWarehouseId, quantity, referenceNo, notes } = req.body;

    if (!materialId) throw new ValidationError('请选择物料');
    if (!fromWarehouseId) throw new ValidationError('请选择源仓库');
    if (!toWarehouseId) throw new ValidationError('请选择目标仓库');
    if (fromWarehouseId === toWarehouseId) throw new ValidationError('源仓库和目标仓库不能相同');
    if (!quantity || quantity <= 0) throw new ValidationError('数量必须大于0');

    const db = getDB();

    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
    if (!material) throw new NotFoundError('物料');
    const fromWh = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(fromWarehouseId);
    if (!fromWh) throw new NotFoundError('源仓库');
    const toWh = db.prepare('SELECT * FROM warehouses WHERE id = ? AND is_active = 1').get(toWarehouseId);
    if (!toWh) throw new NotFoundError('目标仓库');
    const document = db.transaction(() => createPostedDocumentFromLegacyPayload(db, {
        docType: 'transfer_execution',
        warehouseId: Number(fromWarehouseId),
        toWarehouseId: Number(toWarehouseId),
        referenceNo,
        notes,
        items: [{
            materialId: Number(materialId),
            quantity: Number(quantity)
        }]
    }, req.session.user.id))();

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'warehouses',
        detail: `调拨: ${material.name} × ${quantity} ${fromWh.name} → ${toWh.name}`,
        ip: req.ip
    });

    res.json({
        success: true,
        data: {
            document: {
                ...document,
                sourceLabel: '仓间调拨'
            }
        },
        message: `调拨已通过新单据入口完成: ${material.name} × ${quantity}`
    });
});

module.exports = router;
