const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { addStock, deductStock, transferStock, adjustStock, getAvailable } = require('./inventory');

const DOC_CONFIG = {
    receive_execution: {
        source: 'manual_in',
        bizType: 'manual_receive',
        prefix: 'RCV',
        permissionResource: 'receive'
    },
    issue_execution: {
        source: 'manual_out',
        bizType: 'manual_issue',
        prefix: 'ISS',
        permissionResource: 'issue'
    },
    shipment_execution: {
        source: 'shipment',
        bizType: 'sales_shipment',
        prefix: 'SH',
        permissionResource: 'shipments'
    },
    production_issue_execution: {
        source: 'production_start',
        bizType: 'production_issue',
        prefix: 'PIS',
        permissionResource: 'production'
    },
    production_receive_execution: {
        source: 'production_complete',
        bizType: 'production_receipt',
        prefix: 'PRC',
        permissionResource: 'production'
    },
    production_return_execution: {
        source: 'production_cancel',
        bizType: 'production_return',
        prefix: 'PRT',
        permissionResource: 'production'
    },
    production_scrap_issue_execution: {
        source: 'production_exception',
        bizType: 'production_scrap',
        prefix: 'PSC',
        permissionResource: 'production'
    },
    production_supplement_issue_execution: {
        source: 'production_exception',
        bizType: 'production_supplement',
        prefix: 'PSU',
        permissionResource: 'production'
    },
    production_over_issue_execution: {
        source: 'production_exception',
        bizType: 'production_over_issue',
        prefix: 'POI',
        permissionResource: 'production'
    },
    production_variance_issue_execution: {
        source: 'production_exception',
        bizType: 'production_variance_issue',
        prefix: 'PVI',
        permissionResource: 'production'
    },
    production_variance_receive_execution: {
        source: 'production_exception',
        bizType: 'production_variance_receive',
        prefix: 'PVR',
        permissionResource: 'production'
    },
    transfer_execution: {
        source: 'transfer',
        bizType: 'warehouse_transfer',
        prefix: 'TRF',
        permissionResource: 'transfer'
    },
    count_execution: {
        source: 'manual_adjust',
        bizType: 'manual_count_adjust',
        prefix: 'CNT',
        permissionResource: 'count'
    }
};

function getDocConfig(docType) {
    const config = DOC_CONFIG[docType];
    if (!config) throw new ValidationError('不支持的单据类型', 'docType');
    return config;
}

function buildExecutedAt() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function generateExecutionDocNo(prefix) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const suffix = Math.floor(Math.random() * 900 + 100);
    return `${prefix}-${datePart}-${timePart}${suffix}`;
}

function generateReversalDocNo(originalDocNo) {
    return `REV-${originalDocNo}`;
}

function normalizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('至少需要一条单据明细', 'items');
    }
    return items.map((item, index) => ({
        lineNo: index + 1,
        materialId: Number(item.materialId),
        quantity: item.quantity !== undefined && item.quantity !== null ? Number(item.quantity) : null,
        unitPrice: item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '' ? Number(item.unitPrice) : null,
        actualQuantity: item.actualQuantity !== undefined && item.actualQuantity !== null && item.actualQuantity !== '' ? Number(item.actualQuantity) : null,
        beforeQuantity: item.beforeQuantity !== undefined && item.beforeQuantity !== null && item.beforeQuantity !== '' ? Number(item.beforeQuantity) : null,
        deltaQuantity: item.deltaQuantity !== undefined && item.deltaQuantity !== null && item.deltaQuantity !== '' ? Number(item.deltaQuantity) : null,
        originalMaterialId: item.originalMaterialId !== undefined && item.originalMaterialId !== null && item.originalMaterialId !== '' ? Number(item.originalMaterialId) : null,
        substitutionType: item.substitutionType ? String(item.substitutionType).trim() : null,
        substitutionReason: item.substitutionReason ? String(item.substitutionReason).trim() : null,
        notes: item.notes ? String(item.notes).trim() : null
    }));
}

function validateHeader(db, docType, payload) {
    const config = getDocConfig(docType);
    const warehouseId = payload.warehouseId ? Number(payload.warehouseId) : null;
    const toWarehouseId = payload.toWarehouseId ? Number(payload.toWarehouseId) : null;

    if (docType === 'transfer_execution') {
        if (!warehouseId || !toWarehouseId) throw new ValidationError('调拨单必须包含源仓和目标仓');
        if (warehouseId === toWarehouseId) throw new ValidationError('源仓和目标仓不能相同');
    } else if (!warehouseId) {
        throw new ValidationError('请选择仓库', 'warehouseId');
    }

    if (warehouseId) {
        const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ? AND is_active = 1').get(warehouseId);
        if (!warehouse) throw new NotFoundError('仓库');
    }
    if (toWarehouseId) {
        const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ? AND is_active = 1').get(toWarehouseId);
        if (!warehouse) throw new NotFoundError('目标仓库');
    }

    return { config, warehouseId, toWarehouseId };
}

function validateItems(db, docType, items, header) {
    return items.map((item) => {
        if (!item.materialId) throw new ValidationError('请选择物料', 'items');
        const material = db.prepare('SELECT id, name, code, unit, is_active FROM materials WHERE id = ?').get(item.materialId);
        if (!material || !material.is_active) throw new NotFoundError('物料');

        if (docType === 'count_execution') {
            if (item.actualQuantity === null || Number.isNaN(item.actualQuantity)) {
                throw new ValidationError('盘点单必须填写实盘数量', 'actualQuantity');
            }
            const beforeQuantity = getAvailable(db, item.materialId, header.warehouseId);
            const actualQuantity = Number(item.actualQuantity);
            return {
                ...item,
                quantity: actualQuantity - beforeQuantity,
                beforeQuantity,
                actualQuantity,
                deltaQuantity: actualQuantity - beforeQuantity,
                unit: material.unit,
                totalPrice: null
            };
        }

        if (item.quantity === null || Number.isNaN(item.quantity) || item.quantity <= 0) {
            throw new ValidationError('数量必须大于0', 'quantity');
        }

        return {
            ...item,
            quantity: Number(item.quantity),
            unit: material.unit,
            totalPrice: item.unitPrice !== null ? Number(item.unitPrice) * Number(item.quantity) : null
        };
    });
}

function replaceDocumentItems(db, documentId, items) {
    db.prepare('DELETE FROM stock_document_items WHERE document_id = ?').run(documentId);
    const insertItem = db.prepare(`
        INSERT INTO stock_document_items (
            document_id, line_no, material_id, quantity, unit, unit_price, total_price,
            before_quantity, actual_quantity, delta_quantity, original_material_id,
            substitution_type, substitution_reason, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item, index) => {
        insertItem.run(
            documentId,
            index + 1,
            item.materialId,
            item.quantity ?? 0,
            item.unit || null,
            item.unitPrice,
            item.totalPrice,
            item.beforeQuantity ?? null,
            item.actualQuantity ?? null,
            item.deltaQuantity ?? null,
            item.originalMaterialId ?? null,
            item.substitutionType || null,
            item.substitutionReason || null,
            item.notes || null
        );
    });
}

function hydrateDocument(db, row) {
    if (!row) return null;
    const items = db.prepare(`
        SELECT sdi.*, m.name as material_name, m.code as material_code,
               om.name as original_material_name, om.code as original_material_code
        FROM stock_document_items sdi
        LEFT JOIN materials m ON sdi.material_id = m.id
        LEFT JOIN materials om ON sdi.original_material_id = om.id
        WHERE sdi.document_id = ?
        ORDER BY sdi.line_no ASC, sdi.id ASC
    `).all(row.id);

    const movements = db.prepare(`
        SELECT sm.*, m.name as material_name, m.code as material_code, m.unit,
               w.name as warehouse_name, tw.name as to_warehouse_name
        FROM stock_movements sm
        LEFT JOIN materials m ON sm.material_id = m.id
        LEFT JOIN warehouses w ON sm.warehouse_id = w.id
        LEFT JOIN warehouses tw ON sm.to_warehouse_id = tw.id
        WHERE sm.source_doc_id = ?
        ORDER BY sm.created_at DESC, sm.id DESC
    `).all(row.id);

    const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const totalAmount = items.reduce((sum, item) => sum + Number(item.total_price || 0), 0);

    return {
        id: row.id,
        documentNo: row.doc_no,
        documentType: row.doc_type,
        documentStatus: row.status,
        bizType: row.biz_type,
        source: row.source,
        isReversal: Boolean(row.is_reversal),
        reversalOfDocumentId: row.reversal_of_document_id || null,
        reversedByDocumentId: row.reversed_by_document_id || null,
        reversedAt: row.reversed_at || null,
        reversalReason: row.reversal_reason || null,
        reversalOfDocumentNo: row.reversal_of_doc_no || null,
        reversedByDocumentNo: row.reversed_by_doc_no || null,
        warehouseId: row.warehouse_id,
        warehouseName: row.warehouse_name || '-',
        fromWarehouseName: row.warehouse_name || '-',
        toWarehouseId: row.to_warehouse_id,
        toWarehouseName: row.to_warehouse_name || '-',
        counterparty: row.counterparty || null,
        referenceNo: row.reference_no || null,
        notes: row.notes || '',
        originType: row.origin_type || null,
        originId: row.origin_id || null,
        executedAt: row.executed_at || null,
        postedAt: row.posted_at || null,
        submittedAt: row.submitted_at || null,
        quantity: totalQuantity,
        totalAmount,
        unit: items.length === 1 ? items[0].unit : '',
        materialName: items.length === 1 ? items[0].material_name : `${items.length} 种物料`,
        materialCode: items.length === 1 ? items[0].material_code : null,
        beforeQuantity: items[0]?.before_quantity ?? null,
        actualQuantity: items[0]?.actual_quantity ?? null,
        delta: items[0]?.delta_quantity ?? totalQuantity,
        items: items.map(item => ({
            id: item.id,
            lineNo: item.line_no,
            materialId: item.material_id,
            materialName: item.material_name,
            materialCode: item.material_code,
            originalMaterialId: item.original_material_id,
            originalMaterialName: item.original_material_name,
            originalMaterialCode: item.original_material_code,
            quantity: item.quantity,
            unit: item.unit,
            unitPrice: item.unit_price,
            totalPrice: item.total_price,
            beforeQuantity: item.before_quantity,
            actualQuantity: item.actual_quantity,
            deltaQuantity: item.delta_quantity,
            substitutionType: item.substitution_type,
            substitutionReason: item.substitution_reason,
            notes: item.notes
        })),
        movements: movements.map(movement => ({
            id: movement.id,
            type: movement.type,
            materialId: movement.material_id,
            warehouseId: movement.warehouse_id,
            toWarehouseId: movement.to_warehouse_id,
            quantity: movement.quantity,
            unit: movement.unit,
            warehouseName: movement.warehouse_name,
            toWarehouseName: movement.to_warehouse_name,
            materialName: movement.material_name,
            materialCode: movement.material_code,
            counterparty: movement.counterparty,
            referenceNo: movement.reference_no,
            sourceLabel: ({
                manual_in: '手工收货 / 回库',
                manual_out: '手工发料 / 出库',
                shipment: '销售发货',
                production_start: '生产领料',
                production_complete: '生产完工入库',
                production_cancel: '生产退料回库',
                transfer: '仓间调拨',
                manual_adjust: '盘点调整'
            })[movement.source] || movement.source || '-',
            documentStatus: movement.doc_status || row.status,
            executedAt: movement.executed_at || movement.created_at,
            notes: movement.notes,
            unitPrice: movement.unit_price,
            totalPrice: movement.total_price
        }))
    };
}

function getDocumentById(db, id) {
    const row = db.prepare(`
        SELECT sd.*, w.name as warehouse_name, tw.name as to_warehouse_name,
               parent.doc_no as reversal_of_doc_no,
               child.doc_no as reversed_by_doc_no
        FROM stock_documents sd
        LEFT JOIN warehouses w ON sd.warehouse_id = w.id
        LEFT JOIN warehouses tw ON sd.to_warehouse_id = tw.id
        LEFT JOIN stock_documents parent ON sd.reversal_of_document_id = parent.id
        LEFT JOIN stock_documents child ON sd.reversed_by_document_id = child.id
        WHERE sd.id = ?
    `).get(id);
    if (!row) throw new NotFoundError('单据');
    return hydrateDocument(db, row);
}

function getDocumentRow(db, id) {
    const row = db.prepare('SELECT * FROM stock_documents WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('单据');
    return row;
}

function listDocumentsByOrigin(db, originType, originId, docType = null) {
    const whereClauses = ['sd.origin_type = ?', 'sd.origin_id = ?'];
    const params = [originType, originId];
    if (docType) {
        whereClauses.push('sd.doc_type = ?');
        params.push(docType);
    }

    const rows = db.prepare(`
        SELECT sd.*, w.name as warehouse_name, tw.name as to_warehouse_name,
               parent.doc_no as reversal_of_doc_no,
               child.doc_no as reversed_by_doc_no
        FROM stock_documents sd
        LEFT JOIN warehouses w ON sd.warehouse_id = w.id
        LEFT JOIN warehouses tw ON sd.to_warehouse_id = tw.id
        LEFT JOIN stock_documents parent ON sd.reversal_of_document_id = parent.id
        LEFT JOIN stock_documents child ON sd.reversed_by_document_id = child.id
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY COALESCE(sd.executed_at, sd.created_at) DESC, sd.id DESC
    `).all(...params);

    return rows.map(row => hydrateDocument(db, row));
}

function createDocument(db, payload, userId, targetStatus = 'draft') {
    const docType = payload.docType;
    const { config, warehouseId, toWarehouseId } = validateHeader(db, docType, payload);
    const items = validateItems(db, docType, normalizeItems(payload.items), { warehouseId, toWarehouseId });
    const originType = payload.originType ? String(payload.originType).trim() : null;
    const originId = payload.originId !== undefined && payload.originId !== null && payload.originId !== ''
        ? Number(payload.originId)
        : null;
    const docNo = payload.referenceNo && String(payload.referenceNo).trim()
        ? String(payload.referenceNo).trim()
        : generateExecutionDocNo(config.prefix);
    const now = buildExecutedAt();

    const result = db.prepare(`
        INSERT INTO stock_documents (
            doc_no, doc_type, biz_type, status, source, warehouse_id, to_warehouse_id,
            counterparty, reference_no, notes, origin_type, origin_id,
            submitted_at, submitted_by, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
    `).run(
        docNo,
        docType,
        config.bizType,
        targetStatus,
        config.source,
        warehouseId,
        toWarehouseId,
        payload.counterparty ? String(payload.counterparty).trim() : null,
        docNo,
        payload.notes ? String(payload.notes).trim() : null,
        originType,
        originId,
        targetStatus === 'submitted' ? now : null,
        targetStatus === 'submitted' ? userId : null,
        userId
    );

    replaceDocumentItems(db, result.lastInsertRowid, items);
    return getDocumentById(db, result.lastInsertRowid);
}

function updateDocument(db, id, payload) {
    const current = getDocumentRow(db, id);
    if (current.status !== 'draft') throw new ConflictError('只有草稿单据允许修改');

    const docType = payload.docType || current.doc_type;
    const { config, warehouseId, toWarehouseId } = validateHeader(db, docType, {
        warehouseId: payload.warehouseId ?? current.warehouse_id,
        toWarehouseId: payload.toWarehouseId ?? current.to_warehouse_id
    });
    const items = validateItems(db, docType, normalizeItems(payload.items), { warehouseId, toWarehouseId });
    const docNo = payload.referenceNo && String(payload.referenceNo).trim()
        ? String(payload.referenceNo).trim()
        : current.doc_no;

    db.prepare(`
        UPDATE stock_documents
        SET doc_no = ?, doc_type = ?, biz_type = ?, source = ?, warehouse_id = ?, to_warehouse_id = ?,
            counterparty = ?, reference_no = ?, notes = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(
        docNo,
        docType,
        config.bizType,
        config.source,
        warehouseId,
        toWarehouseId,
        payload.counterparty !== undefined ? (payload.counterparty ? String(payload.counterparty).trim() : null) : current.counterparty,
        docNo,
        payload.notes !== undefined ? (payload.notes ? String(payload.notes).trim() : null) : current.notes,
        id
    );

    replaceDocumentItems(db, id, items);
    return getDocumentById(db, id);
}

function submitDocument(db, id, userId) {
    const current = getDocumentRow(db, id);
    if (current.status !== 'draft') throw new ConflictError('只有草稿单据允许提交');
    const now = buildExecutedAt();
    db.prepare(`
        UPDATE stock_documents
        SET status = 'submitted', submitted_at = ?, submitted_by = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(now, userId, id);
    return getDocumentById(db, id);
}

function applyExecution(db, document, userId) {
    const config = getDocConfig(document.documentType);
    const executedAt = buildExecutedAt();
    const isReversal = Boolean(document.isReversal);

    document.items.forEach(item => {
        const base = {
            materialId: item.materialId,
            referenceNo: document.documentNo,
            notes: item.notes || document.notes,
            source: config.source,
            userId,
            sourceDocId: document.id,
            sourceDocType: document.documentType,
            docStatus: 'executed',
            executedAt,
            bizType: config.bizType
        };

        if (document.documentType === 'receive_execution') {
            if (isReversal) {
                deductStock(db, {
                    ...base,
                    warehouseId: document.warehouseId,
                    quantity: Number(item.quantity),
                    unitPrice: item.unitPrice,
                    counterparty: document.counterparty
                });
            } else {
                addStock(db, {
                    ...base,
                    warehouseId: document.warehouseId,
                    quantity: Number(item.quantity),
                    unitPrice: item.unitPrice,
                    counterparty: document.counterparty
                });
            }
        } else if (
            document.documentType === 'issue_execution' ||
            document.documentType === 'shipment_execution' ||
            document.documentType === 'production_issue_execution' ||
            document.documentType === 'production_scrap_issue_execution' ||
            document.documentType === 'production_supplement_issue_execution' ||
            document.documentType === 'production_over_issue_execution' ||
            document.documentType === 'production_variance_issue_execution'
        ) {
            if (isReversal) {
                addStock(db, {
                    ...base,
                    warehouseId: document.warehouseId,
                    quantity: Number(item.quantity),
                    unitPrice: item.unitPrice,
                    counterparty: document.counterparty
                });
            } else {
                deductStock(db, {
                    ...base,
                    warehouseId: document.warehouseId,
                    quantity: Number(item.quantity),
                    unitPrice: item.unitPrice,
                    counterparty: document.counterparty
                });
            }
        } else if (
            document.documentType === 'production_receive_execution' ||
            document.documentType === 'production_return_execution' ||
            document.documentType === 'production_variance_receive_execution'
        ) {
            if (isReversal) {
                deductStock(db, {
                    ...base,
                    warehouseId: document.warehouseId,
                    quantity: Number(item.quantity),
                    unitPrice: item.unitPrice,
                    counterparty: document.counterparty
                });
            } else {
                addStock(db, {
                    ...base,
                    warehouseId: document.warehouseId,
                    quantity: Number(item.quantity),
                    unitPrice: item.unitPrice,
                    counterparty: document.counterparty
                });
            }
        } else if (document.documentType === 'transfer_execution') {
            transferStock(db, {
                ...base,
                fromWarehouseId: isReversal ? document.toWarehouseId : document.warehouseId,
                toWarehouseId: isReversal ? document.warehouseId : document.toWarehouseId,
                quantity: Number(item.quantity)
            });
        } else if (document.documentType === 'count_execution') {
            adjustStock(db, {
                ...base,
                warehouseId: document.warehouseId,
                actualQuantity: Number(item.actualQuantity),
                counterparty: document.counterparty
            });
        }
    });

    return executedAt;
}

function executeDocument(db, id, userId) {
    const current = getDocumentById(db, id);
    if (current.documentStatus !== 'submitted') throw new ConflictError('只有已提交单据允许执行');
    const executedAt = applyExecution(db, current, userId);
    db.prepare(`
        UPDATE stock_documents
        SET status = 'executed', executed_at = ?, executed_by = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(executedAt, userId, id);
    return getDocumentById(db, id);
}

function postDocument(db, id, userId) {
    const current = getDocumentRow(db, id);
    if (current.status !== 'executed') throw new ConflictError('只有已执行单据允许记账');
    if (current.reversed_by_document_id) throw new ConflictError('原单已生成红冲单，不能再直接记账或反向流转');
    const now = buildExecutedAt();
    db.prepare(`
        UPDATE stock_documents
        SET status = 'posted', posted_at = ?, posted_by = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(now, userId, id);
    db.prepare(`
        UPDATE stock_movements
        SET doc_status = 'posted'
        WHERE source_doc_id = ?
    `).run(id);
    return getDocumentById(db, id);
}

function ensureNoLaterWarehouseActivity(db, { materialId, warehouseId, movementId, documentId }) {
    const later = db.prepare(`
        SELECT id
        FROM stock_movements
        WHERE material_id = ?
          AND id > ?
          AND IFNULL(source_doc_id, 0) != ?
          AND (warehouse_id = ? OR to_warehouse_id = ?)
        LIMIT 1
    `).get(materialId, movementId, documentId || 0, warehouseId, warehouseId);

    if (later) {
        throw new ConflictError('该单据执行后已有后续库存流水，不能直接撤销执行');
    }
}

function applyInventoryDeltaWithoutLog(db, materialId, warehouseId, delta) {
    const current = getAvailable(db, materialId, warehouseId);
    const next = current + Number(delta);
    if (next < 0) throw new ConflictError(`撤销执行失败，仓库当前库存不足以回退，当前库存: ${current}`);

    const existing = db.prepare(
        'SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, warehouseId);

    if (existing) {
        db.prepare(`
            UPDATE inventory
            SET quantity = ?, updated_at = datetime('now', 'localtime')
            WHERE material_id = ? AND warehouse_id = ?
        `).run(next, materialId, warehouseId);
    } else {
        db.prepare(
            'INSERT INTO inventory (material_id, warehouse_id, quantity) VALUES (?, ?, ?)'
        ).run(materialId, warehouseId, next);
    }
}

function setInventoryQuantityWithoutLog(db, materialId, warehouseId, quantity) {
    const normalized = Number(quantity || 0);
    const existing = db.prepare(
        'SELECT id FROM inventory WHERE material_id = ? AND warehouse_id = ?'
    ).get(materialId, warehouseId);

    if (existing) {
        db.prepare(`
            UPDATE inventory
            SET quantity = ?, updated_at = datetime('now', 'localtime')
            WHERE material_id = ? AND warehouse_id = ?
        `).run(normalized, materialId, warehouseId);
    } else {
        db.prepare(
            'INSERT INTO inventory (material_id, warehouse_id, quantity) VALUES (?, ?, ?)'
        ).run(materialId, warehouseId, normalized);
    }
}

function unexecuteDocument(db, id, userId, reason = '') {
    const current = getDocumentById(db, id);
    if (current.documentStatus !== 'executed') throw new ConflictError('只有已执行单据允许撤销执行');

    current.movements.forEach((movement) => {
        ensureNoLaterWarehouseActivity(db, {
            materialId: movement.materialId,
            warehouseId: movement.warehouseId,
            movementId: movement.id,
            documentId: current.id
        });
        if (movement.toWarehouseId) {
            ensureNoLaterWarehouseActivity(db, {
                materialId: movement.materialId,
                warehouseId: movement.toWarehouseId,
                movementId: movement.id,
                documentId: current.id
            });
        }
    });

    current.items.forEach((item) => {
        if (current.documentType === 'receive_execution' || current.documentType === 'production_receive_execution' || current.documentType === 'production_return_execution') {
            applyInventoryDeltaWithoutLog(db, item.materialId, current.warehouseId, current.isReversal ? Number(item.quantity) : -Number(item.quantity));
        } else if (current.documentType === 'issue_execution' || current.documentType === 'shipment_execution' || current.documentType === 'production_issue_execution') {
            applyInventoryDeltaWithoutLog(db, item.materialId, current.warehouseId, current.isReversal ? -Number(item.quantity) : Number(item.quantity));
        } else if (current.documentType === 'transfer_execution') {
            if (current.isReversal) {
                applyInventoryDeltaWithoutLog(db, item.materialId, current.warehouseId, -Number(item.quantity));
                applyInventoryDeltaWithoutLog(db, item.materialId, current.toWarehouseId, Number(item.quantity));
            } else {
                applyInventoryDeltaWithoutLog(db, item.materialId, current.toWarehouseId, -Number(item.quantity));
                applyInventoryDeltaWithoutLog(db, item.materialId, current.warehouseId, Number(item.quantity));
            }
        } else if (current.documentType === 'count_execution') {
            setInventoryQuantityWithoutLog(db, item.materialId, current.warehouseId, Number(item.beforeQuantity || 0));
        }
    });

    db.prepare('DELETE FROM stock_movements WHERE source_doc_id = ?').run(id);
    db.prepare(`
        UPDATE stock_documents
        SET status = 'submitted',
            executed_at = NULL,
            executed_by = NULL,
            status_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(reason || 'unexecuted', id);

    if (current.isReversal && current.reversalOfDocumentId) {
        db.prepare(`
            UPDATE stock_documents
            SET reversed_by_document_id = NULL,
                reversed_at = NULL,
                reversal_reason = NULL,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(current.reversalOfDocumentId);
    }

    return getDocumentById(db, id);
}

function discardDraftDocument(db, id, userId, reason = '') {
    const current = getDocumentRow(db, id);
    if (current.status !== 'draft') throw new ConflictError('只有草稿单据允许撤销');
    db.prepare(`
        UPDATE stock_documents
        SET status = 'voided',
            voided_at = ?,
            voided_by = ?,
            status_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(buildExecutedAt(), userId, reason || 'discard_draft', id);
    return getDocumentById(db, id);
}

function voidDocument(db, id, userId, reason = '') {
    const current = getDocumentRow(db, id);
    if (current.status !== 'submitted') throw new ConflictError('只有已提交单据允许作废');
    db.prepare(`
        UPDATE stock_documents
        SET status = 'voided',
            voided_at = ?,
            voided_by = ?,
            status_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(buildExecutedAt(), userId, reason || 'voided', id);
    return getDocumentById(db, id);
}

function unpostDocument(db, id, userId, reason = '') {
    const current = getDocumentRow(db, id);
    if (current.status !== 'posted') throw new ConflictError('只有已记账单据允许反记账');
    if (current.reversed_by_document_id) throw new ConflictError('原单已生成红冲单，请先处理红冲单后再操作原单');
    db.prepare(`
        UPDATE stock_documents
        SET status = 'executed',
            posted_at = NULL,
            posted_by = NULL,
            status_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(reason || 'unposted', id);
    db.prepare(`
        UPDATE stock_movements
        SET doc_status = 'executed'
        WHERE source_doc_id = ?
    `).run(id);
    return getDocumentById(db, id);
}

function reverseDocument(db, id, userId, reason = '') {
    const current = getDocumentById(db, id);
    const currentRow = getDocumentRow(db, id);
    const normalizedReason = String(reason || '').trim();
    if (current.documentStatus !== 'posted') throw new ConflictError('只有已记账单据允许红冲');
    if (current.isReversal) throw new ConflictError('红冲单不允许再次红冲');
    if (current.reversedByDocumentId) throw new ConflictError('该单据已生成红冲单，不能重复红冲');
    if (!normalizedReason) throw new ValidationError('红冲原因不能为空', 'reason');

    const payload = {
        docType: current.documentType,
        warehouseId: current.warehouseId,
        toWarehouseId: current.toWarehouseId,
        counterparty: current.counterparty,
        referenceNo: generateReversalDocNo(current.documentNo),
        originType: current.originType,
        originId: current.originId,
        notes: [current.notes, `红冲原单 ${current.documentNo}`, `原因: ${normalizedReason}`].filter(Boolean).join(' | '),
        items: current.items.map(item => ({
            materialId: item.materialId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            actualQuantity: current.documentType === 'count_execution' ? item.beforeQuantity : undefined,
            notes: item.notes
        }))
    };

    const reversal = createDocument(db, payload, userId, 'submitted');
    const reversalReason = normalizedReason;

    db.prepare(`
        UPDATE stock_documents
        SET is_reversal = 1,
            reversal_of_document_id = ?,
            reversal_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(current.id, reversalReason, reversal.id);

    db.prepare(`
        UPDATE stock_documents
        SET reversed_by_document_id = ?,
            reversed_at = ?,
            reversal_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(reversal.id, buildExecutedAt(), reversalReason, currentRow.id);

    executeDocument(db, reversal.id, userId);
    postDocument(db, reversal.id, userId);
    return getDocumentById(db, reversal.id);
}

module.exports = {
    DOC_CONFIG,
    createDocument,
    updateDocument,
    submitDocument,
    executeDocument,
    postDocument,
    reverseDocument,
    unexecuteDocument,
    discardDraftDocument,
    voidDocument,
    unpostDocument,
    getDocumentById,
    listDocumentsByOrigin,
    getDocConfig
};
