const express = require('express');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { hasPermission } = require('../middleware/permission');
const { ValidationError, PermissionError } = require('../utils/errors');
const { logOperation } = require('../utils/logger');
const {
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
    getDocConfig
} = require('../services/stockDocuments');

const router = express.Router();
router.use(requireAuth);

function requireDocumentPermission(action, getDocType) {
    return (req, res, next) => {
        const db = getDB();
        const user = req.session.user;
        const docType = typeof getDocType === 'function' ? getDocType(req, db) : getDocType;
        const resource = getDocConfig(docType).permissionResource;

        if (!hasPermission(db, user.role, resource, action)) {
            throw new PermissionError(`没有${resource}的${action}权限`);
        }
        next();
    };
}

function auditDocument(req, action, document, detail) {
    const resource = document?.documentType ? getDocConfig(document.documentType).permissionResource : 'stock_documents';
    logOperation({
        userId: req.session.user.id,
        action,
        resource,
        resourceId: document?.id || null,
        detail,
        ip: req.ip
    });
}

function ensureListViewPermission(req, res, next) {
    const db = getDB();
    const user = req.session.user;
    const docType = req.query.docType ? String(req.query.docType) : '';
    const docTypes = docType ? [docType] : Object.keys(DOC_CONFIG);

    const canView = docTypes.some(type => {
        try {
            return hasPermission(db, user.role, getDocConfig(type).permissionResource, 'view');
        } catch {
            return false;
        }
    });

    if (!canView) throw new PermissionError('没有查看单据的权限');
    next();
}

router.get('/', ensureListViewPermission, (req, res) => {
    const db = getDB();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const whereClauses = [];
    const params = [];

    if (req.query.docType) { whereClauses.push('sd.doc_type = ?'); params.push(String(req.query.docType)); }
    if (req.query.status) { whereClauses.push('sd.status = ?'); params.push(String(req.query.status)); }
    if (req.query.warehouseId) { whereClauses.push('sd.warehouse_id = ?'); params.push(Number(req.query.warehouseId)); }
    if (req.query.toWarehouseId) { whereClauses.push('sd.to_warehouse_id = ?'); params.push(Number(req.query.toWarehouseId)); }
    if (req.query.referenceNo) {
        whereClauses.push('(sd.doc_no LIKE ? OR sd.reference_no LIKE ?)');
        params.push(`%${req.query.referenceNo}%`, `%${req.query.referenceNo}%`);
    }
    if (req.query.start) { whereClauses.push("date(COALESCE(sd.submitted_at, sd.executed_at, sd.posted_at, sd.created_at)) >= date(?)"); params.push(req.query.start); }
    if (req.query.end) { whereClauses.push("date(COALESCE(sd.submitted_at, sd.executed_at, sd.posted_at, sd.created_at)) <= date(?)"); params.push(req.query.end); }
    if (req.query.materialId) {
        whereClauses.push('EXISTS (SELECT 1 FROM stock_document_items sdi WHERE sdi.document_id = sd.id AND sdi.material_id = ?)');
        params.push(Number(req.query.materialId));
    }
    if (req.query.counterparty) { whereClauses.push('sd.counterparty LIKE ?'); params.push(`%${req.query.counterparty}%`); }

    const whereSQL = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) as cnt FROM stock_documents sd ${whereSQL}`).get(...params).cnt;
    const statusRows = db.prepare(`
        SELECT sd.status, COUNT(*) as cnt
        FROM stock_documents sd
        ${whereSQL}
        GROUP BY sd.status
    `).all(...params);
    const rows = db.prepare(`
        SELECT
            sd.*,
            w.name as warehouse_name,
            tw.name as to_warehouse_name,
            parent.doc_no as reversal_of_doc_no,
            child.doc_no as reversed_by_doc_no,
            COUNT(sdi.id) as item_count,
            COALESCE(SUM(sdi.quantity), 0) as total_quantity,
            COALESCE(SUM(sdi.total_price), 0) as total_amount,
            MAX(m.name) as material_name,
            MAX(m.code) as material_code,
            MAX(sdi.unit) as unit
        FROM stock_documents sd
        LEFT JOIN warehouses w ON sd.warehouse_id = w.id
        LEFT JOIN warehouses tw ON sd.to_warehouse_id = tw.id
        LEFT JOIN stock_documents parent ON sd.reversal_of_document_id = parent.id
        LEFT JOIN stock_documents child ON sd.reversed_by_document_id = child.id
        LEFT JOIN stock_document_items sdi ON sdi.document_id = sd.id
        LEFT JOIN materials m ON sdi.material_id = m.id
        ${whereSQL}
        GROUP BY sd.id
        ORDER BY COALESCE(sd.posted_at, sd.executed_at, sd.submitted_at, sd.created_at) DESC, sd.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    res.json({
        success: true,
        data: {
            items: rows.map(row => ({
                id: row.id,
                documentNo: row.doc_no,
                documentType: row.doc_type,
                documentStatus: row.status,
                bizType: row.biz_type,
                isReversal: Boolean(row.is_reversal),
                reversalOfDocumentId: row.reversal_of_document_id,
                reversalOfDocumentNo: row.reversal_of_doc_no || null,
                reversedByDocumentId: row.reversed_by_document_id,
                reversedByDocumentNo: row.reversed_by_doc_no || null,
                reversalReason: row.reversal_reason || null,
                warehouseId: row.warehouse_id,
                warehouseName: row.warehouse_name || '-',
                fromWarehouseName: row.warehouse_name || '-',
                toWarehouseId: row.to_warehouse_id,
                toWarehouseName: row.to_warehouse_name || '-',
                counterparty: row.counterparty || null,
                quantity: row.total_quantity,
                totalAmount: row.total_amount,
                itemCount: row.item_count,
                materialName: row.item_count === 1 ? row.material_name : `${row.item_count} 条明细`,
                materialCode: row.item_count === 1 ? row.material_code : null,
                unit: row.item_count === 1 ? row.unit : '',
                executedAt: row.executed_at,
                submittedAt: row.submitted_at,
                postedAt: row.posted_at,
                notes: row.notes || ''
            })),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            statusSummary: statusRows.reduce((summary, row) => {
                summary[row.status] = row.cnt;
                return summary;
            }, { draft: 0, submitted: 0, executed: 0, posted: 0, voided: 0 })
        }
    });
});

router.get('/:id',
    (req, res, next) => {
        const db = getDB();
        const document = getDocumentById(db, Number(req.params.id));
        req.documentType = document.documentType;
        next();
    },
    requireDocumentPermission('view', req => req.documentType),
    (req, res) => {
        const db = getDB();
        const document = getDocumentById(db, Number(req.params.id));
        res.json({ success: true, data: { document } });
    }
);

router.post('/', requireDocumentPermission('edit', req => req.body.docType), (req, res) => {
    const db = getDB();
    const mode = req.body.mode === 'submit' ? 'submitted' : 'draft';
    const run = db.transaction(() => createDocument(db, req.body, req.session.user.id, mode));
    const document = run();
    auditDocument(req, 'create', document, `创建单据 ${document.documentNo}，状态 ${document.documentStatus}`);
    res.status(201).json({ success: true, data: { document } });
});

router.put('/:id',
    (req, res, next) => {
        const db = getDB();
        const row = getDocumentById(db, Number(req.params.id));
        req.document = row;
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => updateDocument(db, Number(req.params.id), req.body));
        const document = run();
        auditDocument(req, 'update', document, `更新单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/submit',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => submitDocument(db, Number(req.params.id), req.session.user.id));
        const document = run();
        auditDocument(req, 'update', document, `提交单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/execute',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => executeDocument(db, Number(req.params.id), req.session.user.id));
        const document = run();
        auditDocument(req, 'update', document, `执行单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/post',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => postDocument(db, Number(req.params.id), req.session.user.id));
        const document = run();
        auditDocument(req, 'update', document, `记账单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/unexecute',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => unexecuteDocument(db, Number(req.params.id), req.session.user.id, req.body?.reason));
        const document = run();
        auditDocument(req, 'update', document, `撤销执行单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/reverse',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => reverseDocument(db, Number(req.params.id), req.session.user.id, req.body?.reason));
        const document = run();
        auditDocument(req, 'update', document, `红冲单据 ${document.reversalOfDocumentNo || document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/discard',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => discardDraftDocument(db, Number(req.params.id), req.session.user.id, req.body?.reason));
        const document = run();
        auditDocument(req, 'update', document, `撤销草稿单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/void',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => voidDocument(db, Number(req.params.id), req.session.user.id, req.body?.reason));
        const document = run();
        auditDocument(req, 'update', document, `作废单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

router.post('/:id/unpost',
    (req, res, next) => {
        const db = getDB();
        req.document = getDocumentById(db, Number(req.params.id));
        next();
    },
    requireDocumentPermission('edit', req => req.document.documentType),
    (req, res) => {
        const db = getDB();
        const run = db.transaction(() => unpostDocument(db, Number(req.params.id), req.session.user.id, req.body?.reason));
        const document = run();
        auditDocument(req, 'update', document, `反记账单据 ${document.documentNo}`);
        res.json({ success: true, data: { document } });
    }
);

module.exports = router;
