const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function ensureMigrationsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    `);
}

function hasTable(db, tableName) {
    const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);
    return !!row;
}

function hasColumn(db, tableName, columnName) {
    if (!hasTable(db, tableName)) return false;
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.some(column => column.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, definition) {
    if (!hasColumn(db, tableName, columnName)) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}

function applySqlFile(db, fileName) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf-8');
    db.exec(sql);
}

function applyMigration(db, name, applyFn) {
    const exists = db.prepare(
        'SELECT 1 FROM schema_migrations WHERE name = ?'
    ).get(name);
    if (exists) return false;

    const run = db.transaction(() => {
        applyFn();
        db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    });
    run();
    return true;
}

function runLegacyMigrations(db) {
    try {
        if (hasTable(db, 'stock_movements') && !hasColumn(db, 'stock_movements', 'source')) {
            db.exec("ALTER TABLE stock_movements ADD COLUMN source TEXT");
            db.exec("CREATE INDEX IF NOT EXISTS idx_movements_source ON stock_movements(source)");
            console.log('📦 迁移完成: stock_movements 增加 source 字段');
        }

        const trigger = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name='prevent_negative_inventory'"
        ).get();
        if (trigger) {
            db.exec('DROP TRIGGER prevent_negative_inventory');
            console.log('📦 迁移完成: 移除非负库存触发器（允许负库存）');
        }
    } catch (err) {
        // 首次初始化或表尚未创建时忽略
    }
}

function runMaterialMasterMigration(db) {
    if (!hasTable(db, 'materials')) return;

    applyMigration(db, '001_material_master_foundation', () => {
        addColumnIfMissing(db, 'materials', 'material_type', "TEXT DEFAULT 'raw'");
        addColumnIfMissing(db, 'materials', 'internal_code', 'TEXT');
        addColumnIfMissing(db, 'materials', 'model', 'TEXT');
        addColumnIfMissing(db, 'materials', 'spec_key', 'TEXT');

        addColumnIfMissing(db, 'materials', 'is_purchasable', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'is_producible', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'is_sellable', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'default_warehouse_id', 'INTEGER REFERENCES warehouses(id)');
        addColumnIfMissing(db, 'materials', 'default_supplier_id', 'INTEGER');
        addColumnIfMissing(db, 'materials', 'lead_time_days', 'INTEGER DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'min_purchase_qty', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'purchase_lot_size', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'tax_rate', 'REAL DEFAULT 0');

        addColumnIfMissing(db, 'materials', 'safety_stock', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'reorder_point', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'economic_order_qty', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'allow_negative_stock', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'is_batch_tracked', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'is_serial_tracked', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'is_expiry_tracked', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'stock_count_cycle_days', 'INTEGER');

        addColumnIfMissing(db, 'materials', 'standard_cost', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'last_purchase_price', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'avg_cost', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'cost_source', "TEXT DEFAULT 'manual'");
        addColumnIfMissing(db, 'materials', 'cost_updated_at', 'TEXT');

        addColumnIfMissing(db, 'materials', 'lifecycle_status', "TEXT NOT NULL DEFAULT 'draft'");
        addColumnIfMissing(db, 'materials', 'activated_at', 'TEXT');
        addColumnIfMissing(db, 'materials', 'obsolete_at', 'TEXT');

        addColumnIfMissing(db, 'materials', 'default_bom_id', 'INTEGER REFERENCES boms(id)');
        addColumnIfMissing(db, 'materials', 'default_sop_id', 'INTEGER REFERENCES sops(id)');
        addColumnIfMissing(db, 'materials', 'yield_rate', 'REAL DEFAULT 1');
        addColumnIfMissing(db, 'materials', 'scrap_rate', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'is_key_part', 'INTEGER NOT NULL DEFAULT 0');

        addColumnIfMissing(db, 'materials', 'master_data_owner', 'INTEGER REFERENCES users(id)');
        addColumnIfMissing(db, 'materials', 'data_quality_status', "TEXT DEFAULT 'normal'");
        addColumnIfMissing(db, 'materials', 'version_no', 'INTEGER NOT NULL DEFAULT 1');

        applySqlFile(db, '001_material_master_foundation.sql');
    });
}

function runWarehouseActionDocumentMigration(db) {
    if (!hasTable(db, 'stock_movements')) return;

    applyMigration(db, '002_stock_movement_document_fields', () => {
        addColumnIfMissing(db, 'stock_movements', 'biz_type', 'TEXT');
        addColumnIfMissing(db, 'stock_movements', 'doc_status', "TEXT DEFAULT 'posted'");
        addColumnIfMissing(db, 'stock_movements', 'source_doc_type', 'TEXT');
        addColumnIfMissing(db, 'stock_movements', 'source_doc_id', 'INTEGER');
        addColumnIfMissing(db, 'stock_movements', 'source_doc_no', 'TEXT');
        addColumnIfMissing(db, 'stock_movements', 'executed_at', 'TEXT');

        db.exec(`
            UPDATE stock_movements
            SET doc_status = COALESCE(doc_status, 'posted'),
                executed_at = COALESCE(executed_at, created_at),
                source_doc_no = COALESCE(source_doc_no, reference_no),
                source_doc_type = CASE
                    WHEN source_doc_type IS NOT NULL AND source_doc_type != '' THEN source_doc_type
                    WHEN source = 'manual_in' THEN 'receive_execution'
                    WHEN source = 'manual_out' THEN 'issue_execution'
                    WHEN source = 'transfer' THEN 'transfer_execution'
                    WHEN source = 'manual_adjust' THEN 'count_execution'
                    ELSE 'legacy_movement'
                END,
                biz_type = CASE
                    WHEN biz_type IS NOT NULL AND biz_type != '' THEN biz_type
                    WHEN source = 'manual_in' THEN 'manual_receive'
                    WHEN source = 'manual_out' THEN 'manual_issue'
                    WHEN source = 'transfer' THEN 'warehouse_transfer'
                    WHEN source = 'manual_adjust' THEN 'manual_count_adjust'
                    ELSE COALESCE(source, type)
                END
        `);
    });
}

function runStockExecutionDocumentStorageMigration(db) {
    applyMigration(db, '003_stock_execution_documents', () => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS stock_documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_no TEXT NOT NULL UNIQUE,
                doc_type TEXT NOT NULL,
                biz_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'posted',
                source TEXT,
                warehouse_id INTEGER REFERENCES warehouses(id),
                to_warehouse_id INTEGER REFERENCES warehouses(id),
                counterparty TEXT,
                reference_no TEXT,
                notes TEXT,
                executed_at TEXT,
                posted_at TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS stock_document_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
                line_no INTEGER NOT NULL DEFAULT 1,
                material_id INTEGER NOT NULL REFERENCES materials(id),
                quantity REAL NOT NULL DEFAULT 0,
                unit TEXT,
                unit_price REAL,
                total_price REAL,
                before_quantity REAL,
                actual_quantity REAL,
                delta_quantity REAL,
                notes TEXT,
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_stock_documents_doc_no ON stock_documents(doc_no);
            CREATE INDEX IF NOT EXISTS idx_stock_documents_type ON stock_documents(doc_type);
            CREATE INDEX IF NOT EXISTS idx_stock_documents_exec ON stock_documents(executed_at);
            CREATE INDEX IF NOT EXISTS idx_stock_document_items_doc ON stock_document_items(document_id);
            CREATE INDEX IF NOT EXISTS idx_stock_document_items_material ON stock_document_items(material_id);
        `);

        if (hasColumn(db, 'stock_movements', 'source_doc_id')) {
            db.exec(`
                INSERT INTO stock_documents (
                    doc_no, doc_type, biz_type, status, source, warehouse_id, to_warehouse_id,
                    counterparty, reference_no, notes, executed_at, posted_at, created_by
                )
                SELECT
                    doc_no,
                    MAX(source_doc_type) as doc_type,
                    MAX(biz_type) as biz_type,
                    COALESCE(MAX(doc_status), 'posted') as status,
                    MAX(source) as source,
                    MAX(warehouse_id) as warehouse_id,
                    MAX(to_warehouse_id) as to_warehouse_id,
                    MAX(counterparty) as counterparty,
                    MAX(reference_no) as reference_no,
                    MAX(notes) as notes,
                    MAX(COALESCE(executed_at, created_at)) as executed_at,
                    MAX(COALESCE(executed_at, created_at)) as posted_at,
                    MAX(created_by) as created_by
                FROM (
                    SELECT
                        id,
                        COALESCE(NULLIF(source_doc_no, ''), NULLIF(reference_no, ''), 'MOV-' || id) as doc_no,
                        source_doc_type,
                        biz_type,
                        doc_status,
                        source,
                        warehouse_id,
                        to_warehouse_id,
                        counterparty,
                        reference_no,
                        notes,
                        executed_at,
                        created_at,
                        created_by
                    FROM stock_movements
                ) grouped
                GROUP BY doc_no
            `);

            db.exec(`
                INSERT INTO stock_document_items (
                    document_id, line_no, material_id, quantity, unit, unit_price, total_price,
                    before_quantity, actual_quantity, delta_quantity, notes
                )
                SELECT
                    sd.id,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(NULLIF(sm.source_doc_no, ''), NULLIF(sm.reference_no, ''), 'MOV-' || sm.id)
                        ORDER BY sm.id
                    ) as line_no,
                    sm.material_id,
                    sm.quantity,
                    m.unit,
                    sm.unit_price,
                    sm.total_price,
                    NULL,
                    NULL,
                    CASE WHEN sm.type = 'adjust' THEN sm.quantity ELSE NULL END,
                    sm.notes
                FROM stock_movements sm
                JOIN stock_documents sd
                  ON sd.doc_no = COALESCE(NULLIF(sm.source_doc_no, ''), NULLIF(sm.reference_no, ''), 'MOV-' || sm.id)
                LEFT JOIN materials m ON sm.material_id = m.id
            `);

            db.exec(`
                UPDATE stock_movements
                SET source_doc_id = (
                    SELECT sd.id FROM stock_documents sd
                    WHERE sd.doc_no = COALESCE(NULLIF(stock_movements.source_doc_no, ''), NULLIF(stock_movements.reference_no, ''), 'MOV-' || stock_movements.id)
                )
                WHERE source_doc_id IS NULL
            `);
        }
    });
}

function runStockDocumentWorkflowMigration(db) {
    if (!hasTable(db, 'stock_documents')) return;

    applyMigration(db, '004_stock_document_workflow_fields', () => {
        addColumnIfMissing(db, 'stock_documents', 'submitted_at', 'TEXT');
        addColumnIfMissing(db, 'stock_documents', 'submitted_by', 'INTEGER REFERENCES users(id)');
        addColumnIfMissing(db, 'stock_documents', 'executed_by', 'INTEGER REFERENCES users(id)');
        addColumnIfMissing(db, 'stock_documents', 'posted_by', 'INTEGER REFERENCES users(id)');
        addColumnIfMissing(db, 'stock_documents', 'voided_at', 'TEXT');
        addColumnIfMissing(db, 'stock_documents', 'voided_by', 'INTEGER REFERENCES users(id)');
        addColumnIfMissing(db, 'stock_documents', 'status_reason', 'TEXT');

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_stock_documents_status ON stock_documents(status);
            CREATE INDEX IF NOT EXISTS idx_stock_documents_type_status ON stock_documents(doc_type, status);
        `);

        db.exec(`
            UPDATE stock_documents
            SET posted_by = COALESCE(posted_by, created_by)
            WHERE status = 'posted' AND posted_by IS NULL
        `);
    });
}

function runStockDocumentReversalMigration(db) {
    if (!hasTable(db, 'stock_documents')) return;

    applyMigration(db, '005_stock_document_reversal_fields', () => {
        addColumnIfMissing(db, 'stock_documents', 'is_reversal', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'stock_documents', 'reversal_of_document_id', 'INTEGER REFERENCES stock_documents(id)');
        addColumnIfMissing(db, 'stock_documents', 'reversed_by_document_id', 'INTEGER REFERENCES stock_documents(id)');
        addColumnIfMissing(db, 'stock_documents', 'reversed_at', 'TEXT');
        addColumnIfMissing(db, 'stock_documents', 'reversal_reason', 'TEXT');

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_stock_documents_reversal_of ON stock_documents(reversal_of_document_id);
            CREATE INDEX IF NOT EXISTS idx_stock_documents_reversed_by ON stock_documents(reversed_by_document_id);
        `);
    });
}

function runShipmentDocumentLinkMigration(db) {
    if (!hasTable(db, 'shipments')) return;

    applyMigration(db, '006_shipment_stock_document_link', () => {
        addColumnIfMissing(db, 'shipments', 'stock_document_id', 'INTEGER REFERENCES stock_documents(id)');

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_shipments_stock_document ON shipments(stock_document_id);
        `);

        if (hasTable(db, 'stock_documents')) {
            db.exec(`
                UPDATE shipments
                SET stock_document_id = (
                    SELECT sd.id
                    FROM stock_documents sd
                    WHERE sd.doc_type = 'shipment_execution'
                      AND (sd.doc_no = shipments.shipment_no OR sd.reference_no = shipments.shipment_no)
                    ORDER BY sd.id DESC
                    LIMIT 1
                )
                WHERE stock_document_id IS NULL
            `);
        }
    });
}

function runProductionDocumentLinkMigration(db) {
    if (!hasTable(db, 'production_orders')) return;

    applyMigration(db, '007_production_stock_document_links', () => {
        addColumnIfMissing(db, 'production_orders', 'issue_document_id', 'INTEGER REFERENCES stock_documents(id)');
        addColumnIfMissing(db, 'production_orders', 'receipt_document_id', 'INTEGER REFERENCES stock_documents(id)');
        addColumnIfMissing(db, 'production_orders', 'return_document_id', 'INTEGER REFERENCES stock_documents(id)');

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_production_issue_document ON production_orders(issue_document_id);
            CREATE INDEX IF NOT EXISTS idx_production_receipt_document ON production_orders(receipt_document_id);
            CREATE INDEX IF NOT EXISTS idx_production_return_document ON production_orders(return_document_id);
        `);
    });
}

function runProductionSnapshotMigration(db) {
    if (!hasTable(db, 'production_orders')) return;

    applyMigration(db, '008_production_order_snapshots', () => {
        addColumnIfMissing(db, 'production_orders', 'snapshot_created_at', 'TEXT');
        addColumnIfMissing(db, 'production_orders', 'sop_snapshot_json', 'TEXT');
        addColumnIfMissing(db, 'production_orders', 'bom_snapshot_json', 'TEXT');
        addColumnIfMissing(db, 'production_orders', 'workorder_snapshot_json', 'TEXT');

        db.exec(`
            UPDATE production_orders
            SET snapshot_created_at = COALESCE(snapshot_created_at, created_at)
            WHERE snapshot_created_at IS NULL
        `);
    });
}

function runStockDocumentOriginMigration(db) {
    if (!hasTable(db, 'stock_documents')) return;

    applyMigration(db, '009_stock_document_origin_links', () => {
        addColumnIfMissing(db, 'stock_documents', 'origin_type', 'TEXT');
        addColumnIfMissing(db, 'stock_documents', 'origin_id', 'INTEGER');

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_stock_documents_origin ON stock_documents(origin_type, origin_id);
        `);

        if (hasTable(db, 'shipments')) {
            db.exec(`
                UPDATE stock_documents
                SET origin_type = 'shipment',
                    origin_id = (
                        SELECT s.id
                        FROM shipments s
                        WHERE s.stock_document_id = stock_documents.id
                        LIMIT 1
                    )
                WHERE origin_id IS NULL
                  AND EXISTS (
                      SELECT 1 FROM shipments s WHERE s.stock_document_id = stock_documents.id
                  )
            `);
        }

        if (hasTable(db, 'production_orders')) {
            db.exec(`
                UPDATE stock_documents
                SET origin_type = 'production_order',
                    origin_id = (
                        SELECT po.id
                        FROM production_orders po
                        WHERE po.issue_document_id = stock_documents.id
                           OR po.receipt_document_id = stock_documents.id
                           OR po.return_document_id = stock_documents.id
                        ORDER BY po.id DESC
                        LIMIT 1
                    )
                WHERE origin_id IS NULL
                  AND EXISTS (
                      SELECT 1
                      FROM production_orders po
                      WHERE po.issue_document_id = stock_documents.id
                         OR po.receipt_document_id = stock_documents.id
                         OR po.return_document_id = stock_documents.id
                  )
            `);
        }
    });
}

function runProductionPartialProgressMigration(db) {
    if (!hasTable(db, 'production_orders')) return;

    applyMigration(db, '010_production_partial_progress_fields', () => {
        addColumnIfMissing(db, 'production_orders', 'returned_quantity', 'REAL DEFAULT 0');

        db.exec(`
            UPDATE production_orders
            SET returned_quantity = COALESCE(returned_quantity, 0)
            WHERE returned_quantity IS NULL
        `);
    });
}

function runProductionExceptionMigration(db) {
    if (!hasTable(db, 'production_orders')) return;

    applyMigration(db, '011_production_exceptions', () => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS production_exceptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exception_no TEXT NOT NULL UNIQUE,
                order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
                exception_type TEXT NOT NULL CHECK(exception_type IN ('scrap', 'supplement', 'over_issue', 'variance')),
                direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
                material_id INTEGER NOT NULL REFERENCES materials(id),
                quantity REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted', 'reversed', 'voided')),
                is_reversal INTEGER NOT NULL DEFAULT 0,
                reversal_of_exception_id INTEGER REFERENCES production_exceptions(id),
                reversed_by_exception_id INTEGER REFERENCES production_exceptions(id),
                reversed_at TEXT,
                reversal_reason TEXT,
                notes TEXT,
                stock_document_id INTEGER REFERENCES stock_documents(id),
                created_by INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_production_exceptions_order ON production_exceptions(order_id);
            CREATE INDEX IF NOT EXISTS idx_production_exceptions_type ON production_exceptions(exception_type);
            CREATE INDEX IF NOT EXISTS idx_production_exceptions_doc ON production_exceptions(stock_document_id);
            CREATE INDEX IF NOT EXISTS idx_production_exceptions_reversal_of ON production_exceptions(reversal_of_exception_id);
            CREATE INDEX IF NOT EXISTS idx_production_exceptions_reversed_by ON production_exceptions(reversed_by_exception_id);
        `);
    });
}

function runProductionExceptionWorkflowMigration(db) {
    if (!hasTable(db, 'production_exceptions')) return;

    applyMigration(db, '012_production_exception_workflow_fields', () => {
        addColumnIfMissing(db, 'production_exceptions', 'status', "TEXT NOT NULL DEFAULT 'posted'");
        addColumnIfMissing(db, 'production_exceptions', 'is_reversal', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'production_exceptions', 'reversal_of_exception_id', 'INTEGER REFERENCES production_exceptions(id)');
        addColumnIfMissing(db, 'production_exceptions', 'reversed_by_exception_id', 'INTEGER REFERENCES production_exceptions(id)');
        addColumnIfMissing(db, 'production_exceptions', 'reversed_at', 'TEXT');
        addColumnIfMissing(db, 'production_exceptions', 'reversal_reason', 'TEXT');

        db.exec(`
            UPDATE production_exceptions
            SET status = COALESCE(status, 'posted'),
                is_reversal = COALESCE(is_reversal, 0)
            WHERE status IS NULL OR is_reversal IS NULL
        `);

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_production_exceptions_reversal_of ON production_exceptions(reversal_of_exception_id);
            CREATE INDEX IF NOT EXISTS idx_production_exceptions_reversed_by ON production_exceptions(reversed_by_exception_id);
        `);
    });
}

function runMaterialSupplyModeMigration(db) {
    if (!hasTable(db, 'materials')) return;

    applyMigration(db, '013_material_supply_mode', () => {
        addColumnIfMissing(db, 'materials', 'supply_mode', "TEXT DEFAULT 'direct_issue'");

        db.exec(`
            UPDATE materials
            SET supply_mode = CASE
                WHEN COALESCE(supply_mode, '') != '' THEN supply_mode
                WHEN material_type = 'wip' THEN 'prebuild_wip'
                WHEN material_type IN ('raw', 'consumable', 'packaging', 'spare') THEN 'purchase_only'
                ELSE 'direct_issue'
            END
        `);
    });
}

function runDualWarningModelMigration(db) {
    if (!hasTable(db, 'materials')) return;

    applyMigration(db, '014_dual_warning_model', () => {
        addColumnIfMissing(db, 'materials', 'target_coverage_qty', 'REAL DEFAULT 0');

        db.exec(`
            UPDATE materials
            SET target_coverage_qty = CASE
                WHEN COALESCE(target_coverage_qty, 0) > 0 THEN target_coverage_qty
                WHEN material_type = 'finished' THEN 1
                WHEN material_type = 'wip' THEN 2
                ELSE 0
            END
        `);
    });
}

function runMaterialSupplierEnrichmentMigration(db) {
    if (!hasTable(db, 'material_suppliers')) return;

    applyMigration(db, '016_material_supplier_enrichment', () => {
        addColumnIfMissing(db, 'material_suppliers', 'supplier_type', "TEXT DEFAULT 'distributor'");
        addColumnIfMissing(db, 'material_suppliers', 'source_platform', "TEXT DEFAULT 'offline'");
        addColumnIfMissing(db, 'material_suppliers', 'shop_name', 'TEXT');
        addColumnIfMissing(db, 'material_suppliers', 'shop_url', 'TEXT');
        addColumnIfMissing(db, 'material_suppliers', 'purchase_url', 'TEXT');
        addColumnIfMissing(db, 'material_suppliers', 'contact_person', 'TEXT');
        addColumnIfMissing(db, 'material_suppliers', 'contact_phone', 'TEXT');
        addColumnIfMissing(db, 'material_suppliers', 'manufacturer_name', 'TEXT');
        addColumnIfMissing(db, 'material_suppliers', 'origin_region', 'TEXT');

        db.exec(`
            UPDATE material_suppliers
            SET supplier_type = COALESCE(NULLIF(TRIM(supplier_type), ''), 'distributor'),
                source_platform = COALESCE(NULLIF(TRIM(source_platform), ''), 'offline')
        `);
    });
}

function runSupplyRiskModelMigration(db) {
    if (!hasTable(db, 'materials')) return;

    applyMigration(db, '017_supply_risk_model', () => {
        addColumnIfMissing(db, 'materials', 'is_single_source', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'coverage_days_target', 'REAL DEFAULT 0');
        addColumnIfMissing(db, 'materials', 'supply_risk_level', "TEXT DEFAULT 'normal'");
        addColumnIfMissing(db, 'materials', 'supply_risk_notes', 'TEXT');

        db.exec(`
            UPDATE materials
            SET supply_risk_level = COALESCE(NULLIF(TRIM(supply_risk_level), ''), 'normal')
        `);
    });
}

function runProductionSubstitutionWorkflowMigration(db) {
    applyMigration(db, '015_production_substitution_workflow', () => {
        if (hasTable(db, 'sop_materials')) {
            addColumnIfMissing(db, 'sop_materials', 'allow_substitution', 'INTEGER NOT NULL DEFAULT 0');
            addColumnIfMissing(db, 'sop_materials', 'substitution_priority', 'INTEGER DEFAULT 1');
        }

        if (hasTable(db, 'bom_items')) {
            addColumnIfMissing(db, 'bom_items', 'allow_substitution', 'INTEGER NOT NULL DEFAULT 0');
            addColumnIfMissing(db, 'bom_items', 'substitution_priority', 'INTEGER DEFAULT 1');
        }

        if (hasTable(db, 'production_orders')) {
            addColumnIfMissing(db, 'production_orders', 'substitution_plan_json', 'TEXT');
            addColumnIfMissing(db, 'production_orders', 'substitution_executed_json', 'TEXT');
        }

        if (hasTable(db, 'stock_document_items')) {
            addColumnIfMissing(db, 'stock_document_items', 'original_material_id', 'INTEGER REFERENCES materials(id)');
            addColumnIfMissing(db, 'stock_document_items', 'substitution_type', 'TEXT');
            addColumnIfMissing(db, 'stock_document_items', 'substitution_reason', 'TEXT');
        }
    });
}

function runMigrations(db) {
    ensureMigrationsTable(db);
    runLegacyMigrations(db);
    runMaterialMasterMigration(db);
    runWarehouseActionDocumentMigration(db);
    runStockExecutionDocumentStorageMigration(db);
    runStockDocumentWorkflowMigration(db);
    runStockDocumentReversalMigration(db);
    runShipmentDocumentLinkMigration(db);
    runProductionDocumentLinkMigration(db);
    runProductionSnapshotMigration(db);
    runStockDocumentOriginMigration(db);
    runProductionPartialProgressMigration(db);
    runProductionExceptionMigration(db);
    runProductionExceptionWorkflowMigration(db);
    runMaterialSupplyModeMigration(db);
    runDualWarningModelMigration(db);
    runMaterialSupplierEnrichmentMigration(db);
    runSupplyRiskModelMigration(db);
    runProductionSubstitutionWorkflowMigration(db);
}

module.exports = { runMigrations };
