/**
 * 库存操作服务
 *
 * 所有库存变更（入库、出库、调拨）统一通过此服务执行。
 * 函数接收 db 实例，在调用方的事务上下文中运行。
 *
 * 数据所有权说明：
 * - 仓储域拥有: warehouses, inventory, stock_movements
 * - 生产域拥有: production_orders, sops, sop_steps, sop_materials
 * - 物料域拥有: materials, categories, boms, bom_items, bom_versions
 * - 销售域拥有: shipments, shipment_items
 *
 * 各模块可读其他域的表，但写 inventory/stock_movements 必须通过本服务。
 */

const { ValidationError } = require('../utils/errors');

function resolveMovementDocumentMeta(type, source, referenceNo, overrides = {}) {
    const metaBySource = {
        manual_in: {
            bizType: 'manual_receive',
            sourceDocType: 'receive_execution',
            sourceLabel: '手工收货 / 回库'
        },
        manual_out: {
            bizType: 'manual_issue',
            sourceDocType: 'issue_execution',
            sourceLabel: '手工发料 / 出库'
        },
        shipment: {
            bizType: 'sales_shipment',
            sourceDocType: 'shipment_execution',
            sourceLabel: '销售发货'
        },
        production_start: {
            bizType: 'production_issue',
            sourceDocType: 'production_issue_execution',
            sourceLabel: '生产领料'
        },
        production_complete: {
            bizType: 'production_receipt',
            sourceDocType: 'production_receive_execution',
            sourceLabel: '生产完工入库'
        },
        production_cancel: {
            bizType: 'production_return',
            sourceDocType: 'production_return_execution',
            sourceLabel: '生产退料回库'
        },
        transfer: {
            bizType: 'warehouse_transfer',
            sourceDocType: 'transfer_execution',
            sourceLabel: '仓间调拨'
        },
        manual_adjust: {
            bizType: 'manual_count_adjust',
            sourceDocType: 'count_execution',
            sourceLabel: '盘点调整'
        }
    };

    const resolved = metaBySource[source] || {};
    return {
        bizType: overrides.bizType || resolved.bizType || source || type,
        docStatus: overrides.docStatus || 'posted',
        sourceDocType: overrides.sourceDocType || resolved.sourceDocType || 'stock_movement',
        sourceDocId: overrides.sourceDocId || null,
        sourceDocNo: referenceNo || null,
        executedAt: overrides.executedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
        sourceLabel: resolved.sourceLabel || source || type
    };
}

/**
 * 查询指定物料在指定仓库的可用库存
 */
function getAvailable(db, materialId, warehouseId) {
    const row = db.prepare(
        'SELECT quantity FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, warehouseId);
    return row ? row.quantity : 0;
}

/**
 * 入库：增加库存 + 记录流水
 * 自动处理"已有记录则加，无记录则新建"
 */
function addStock(db, { materialId, warehouseId, quantity, unitPrice, referenceNo, counterparty, notes, source, userId, sourceDocId, sourceDocType, docStatus, executedAt, bizType }) {
    if (!materialId || !warehouseId) throw new ValidationError('物料ID和仓库ID不能为空');
    if (!quantity || quantity <= 0) throw new ValidationError('入库数量必须大于0');

    const existing = db.prepare(
        'SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, warehouseId);

    if (existing) {
        db.prepare(`
            UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now', 'localtime')
            WHERE material_id = ? AND warehouse_id = ?
        `).run(quantity, materialId, warehouseId);
    } else {
        db.prepare(
            'INSERT INTO inventory (material_id, warehouse_id, quantity) VALUES (?, ?, ?)'
        ).run(materialId, warehouseId, quantity);
    }

    const totalPrice = unitPrice ? unitPrice * quantity : null;
    const docMeta = resolveMovementDocumentMeta('in', source, referenceNo, { sourceDocId, sourceDocType, docStatus, executedAt, bizType });

    db.prepare(`
        INSERT INTO stock_movements (
            type, material_id, warehouse_id, quantity, unit_price, total_price,
            biz_type, doc_status, source_doc_type, source_doc_id, source_doc_no, executed_at,
            reference_no, counterparty, notes, source, created_by
        )
        VALUES ('in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        materialId, warehouseId, quantity, unitPrice || null, totalPrice,
        docMeta.bizType, docMeta.docStatus, docMeta.sourceDocType, docMeta.sourceDocId, docMeta.sourceDocNo, docMeta.executedAt,
        referenceNo || null, counterparty || null, notes || null, source || null, userId
    );
}

/**
 * 出库：减少库存 + 记录流水
 * 库存不足时抛出 ValidationError
 * @param {boolean} opts.skipCheck - 跳过库存检查（用于生产领料等已预先检查的场景）
 */
function deductStock(db, { materialId, warehouseId, quantity, unitPrice, referenceNo, counterparty, notes, source, userId, skipCheck, sourceDocId, sourceDocType, docStatus, executedAt, bizType }) {
    if (!materialId || !warehouseId) throw new ValidationError('物料ID和仓库ID不能为空');
    if (!quantity || quantity <= 0) throw new ValidationError('出库数量必须大于0');

    if (!skipCheck) {
        const available = getAvailable(db, materialId, warehouseId);
        if (available < quantity) {
            throw new ValidationError(`库存不足，当前库存: ${available}，需要: ${quantity}`);
        }
    }

    const existing = db.prepare(
        'SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, warehouseId);

    if (existing) {
        db.prepare(`
            UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now', 'localtime')
            WHERE material_id = ? AND warehouse_id = ?
        `).run(quantity, materialId, warehouseId);
    } else {
        // 无记录时创建负库存记录（欠料）
        db.prepare(
            'INSERT INTO inventory (material_id, warehouse_id, quantity) VALUES (?, ?, ?)'
        ).run(materialId, warehouseId, -quantity);
    }

    const totalPrice = unitPrice ? unitPrice * quantity : null;
    const docMeta = resolveMovementDocumentMeta('out', source, referenceNo, { sourceDocId, sourceDocType, docStatus, executedAt, bizType });

    db.prepare(`
        INSERT INTO stock_movements (
            type, material_id, warehouse_id, quantity, unit_price, total_price,
            biz_type, doc_status, source_doc_type, source_doc_id, source_doc_no, executed_at,
            reference_no, counterparty, notes, source, created_by
        )
        VALUES ('out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        materialId, warehouseId, quantity, unitPrice || null, totalPrice,
        docMeta.bizType, docMeta.docStatus, docMeta.sourceDocType, docMeta.sourceDocId, docMeta.sourceDocNo, docMeta.executedAt,
        referenceNo || null, counterparty || null, notes || null, source || null, userId
    );
}

/**
 * 调拨：源仓减 + 目标仓加 + 记录调拨流水
 */
function transferStock(db, { materialId, fromWarehouseId, toWarehouseId, quantity, referenceNo, notes, source, userId, sourceDocId, sourceDocType, docStatus, executedAt, bizType }) {
    if (!materialId) throw new ValidationError('请选择物料');
    if (!fromWarehouseId || !toWarehouseId) throw new ValidationError('请选择仓库');
    if (fromWarehouseId === toWarehouseId) throw new ValidationError('源仓库和目标仓库不能相同');
    if (!quantity || quantity <= 0) throw new ValidationError('数量必须大于0');

    const available = getAvailable(db, materialId, fromWarehouseId);
    if (available < quantity) {
        throw new ValidationError(`源仓库库存不足，当前: ${available}，需要: ${quantity}`);
    }

    // 源仓减
    db.prepare(`
        UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now', 'localtime')
        WHERE material_id = ? AND warehouse_id = ?
    `).run(quantity, materialId, fromWarehouseId);

    // 目标仓加
    const existing = db.prepare(
        'SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, toWarehouseId);

    if (existing) {
        db.prepare(`
            UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now', 'localtime')
            WHERE material_id = ? AND warehouse_id = ?
        `).run(quantity, materialId, toWarehouseId);
    } else {
        db.prepare(
            'INSERT INTO inventory (material_id, warehouse_id, quantity) VALUES (?, ?, ?)'
        ).run(materialId, toWarehouseId, quantity);
    }

    // 记录调拨流水
    const docMeta = resolveMovementDocumentMeta('transfer', source, referenceNo, { sourceDocId, sourceDocType, docStatus, executedAt, bizType });

    db.prepare(`
        INSERT INTO stock_movements (
            type, material_id, warehouse_id, to_warehouse_id, quantity,
            biz_type, doc_status, source_doc_type, source_doc_id, source_doc_no, executed_at,
            reference_no, notes, source, created_by
        )
        VALUES ('transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        materialId, fromWarehouseId, toWarehouseId, quantity,
        docMeta.bizType, docMeta.docStatus, docMeta.sourceDocType, docMeta.sourceDocId, docMeta.sourceDocNo, docMeta.executedAt,
        referenceNo || null, notes || null, source || null, userId
    );
}

/**
 * 盘点/调整：把库存校正到指定实际数量，并记录调整流水
 */
function adjustStock(db, { materialId, warehouseId, actualQuantity, referenceNo, counterparty, notes, source, userId, sourceDocId, sourceDocType, docStatus, executedAt, bizType }) {
    if (!materialId || !warehouseId) throw new ValidationError('物料ID和仓库ID不能为空');
    if (actualQuantity === undefined || actualQuantity === null || Number.isNaN(Number(actualQuantity))) {
        throw new ValidationError('实际数量不能为空');
    }

    const normalizedActual = Number(actualQuantity);
    const currentQuantity = getAvailable(db, materialId, warehouseId);
    const delta = normalizedActual - currentQuantity;

    const existing = db.prepare(
        'SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, warehouseId);

    if (existing) {
        db.prepare(`
            UPDATE inventory
            SET quantity = ?, updated_at = datetime('now', 'localtime')
            WHERE material_id = ? AND warehouse_id = ?
        `).run(normalizedActual, materialId, warehouseId);
    } else {
        db.prepare(
            'INSERT INTO inventory (material_id, warehouse_id, quantity) VALUES (?, ?, ?)'
        ).run(materialId, warehouseId, normalizedActual);
    }

    const docMeta = resolveMovementDocumentMeta('adjust', source, referenceNo, { sourceDocId, sourceDocType, docStatus, executedAt, bizType });

    db.prepare(`
        INSERT INTO stock_movements (
            type, material_id, warehouse_id, quantity,
            biz_type, doc_status, source_doc_type, source_doc_id, source_doc_no, executed_at,
            reference_no, counterparty, notes, source, created_by
        )
        VALUES ('adjust', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        materialId,
        warehouseId,
        delta,
        docMeta.bizType,
        docMeta.docStatus,
        docMeta.sourceDocType,
        docMeta.sourceDocId,
        docMeta.sourceDocNo,
        docMeta.executedAt,
        referenceNo || null,
        counterparty || null,
        notes || null,
        source || null,
        userId
    );

    return { beforeQuantity: currentQuantity, actualQuantity: normalizedActual, delta };
}

module.exports = { getAvailable, addStock, deductStock, transferStock, adjustStock };
