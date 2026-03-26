-- ============================================
-- OvO System 数据库 Schema
-- ============================================

-- 启用WAL模式（提升并发读性能）
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================
-- 用户与权限
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'editor', 'viewer')),
    is_active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    resource TEXT NOT NULL,
    can_view INTEGER NOT NULL DEFAULT 0,
    can_add INTEGER NOT NULL DEFAULT 0,
    can_edit INTEGER NOT NULL DEFAULT 0,
    can_delete INTEGER NOT NULL DEFAULT 0,
    UNIQUE(role, resource)
);

-- ============================================
-- 操作日志
-- ============================================
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    resource_id INTEGER,
    detail TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_logs_user ON operation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_date ON operation_logs(created_at);

-- ============================================
-- 物料分类
-- ============================================
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_pinyin TEXT,
    name_pinyin_abbr TEXT,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- ============================================
-- 物料主表
-- ============================================
CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    name_pinyin TEXT,
    name_pinyin_abbr TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    unit TEXT NOT NULL DEFAULT '个',
    spec TEXT,
    brand TEXT,
    description TEXT,
    min_stock INTEGER DEFAULT 0,
    max_stock INTEGER,
    cost_price REAL DEFAULT 0,
    sale_price REAL DEFAULT 0,
    image_url TEXT,
    barcode TEXT,
    weight REAL,
    dimensions TEXT,
    supplier TEXT,
    supplier_contact TEXT,
    notes TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    target_coverage_qty REAL DEFAULT 0,
    is_single_source INTEGER NOT NULL DEFAULT 0,
    coverage_days_target REAL DEFAULT 0,
    supply_risk_level TEXT DEFAULT 'normal',
    supply_risk_notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_materials_pinyin ON materials(name_pinyin);
CREATE INDEX IF NOT EXISTS idx_materials_pinyin_abbr ON materials(name_pinyin_abbr);
CREATE INDEX IF NOT EXISTS idx_materials_code ON materials(code);
CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category_id);
CREATE INDEX IF NOT EXISTS idx_materials_name ON materials(name);

CREATE TABLE IF NOT EXISTS material_suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    supplier_name TEXT NOT NULL,
    supplier_material_code TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    lead_time_days INTEGER DEFAULT 0,
    min_order_qty REAL DEFAULT 0,
    lot_size REAL DEFAULT 0,
    last_purchase_price REAL DEFAULT 0,
    supplier_type TEXT DEFAULT 'distributor',
    source_platform TEXT DEFAULT 'offline',
    shop_name TEXT,
    shop_url TEXT,
    purchase_url TEXT,
    contact_person TEXT,
    contact_phone TEXT,
    manufacturer_name TEXT,
    origin_region TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_material_suppliers_material ON material_suppliers(material_id);

-- ============================================
-- 仓库
-- ============================================
CREATE TABLE IF NOT EXISTS warehouses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_pinyin TEXT,
    name_pinyin_abbr TEXT,
    address TEXT,
    contact_person TEXT,
    contact_phone TEXT,
    notes TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- ============================================
-- 库存（物料×仓库 唯一）
-- ============================================
CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    quantity INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(material_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_material ON inventory(material_id);
CREATE INDEX IF NOT EXISTS idx_inventory_warehouse ON inventory(warehouse_id);

-- ============================================
-- 出入库流水
-- ============================================
CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('in', 'out', 'transfer', 'adjust')),
    material_id INTEGER NOT NULL REFERENCES materials(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    to_warehouse_id INTEGER REFERENCES warehouses(id),
    quantity INTEGER NOT NULL,
    unit_price REAL,
    total_price REAL,
    biz_type TEXT,
    doc_status TEXT DEFAULT 'posted',
    source_doc_type TEXT,
    source_doc_id INTEGER,
    source_doc_no TEXT,
    executed_at TEXT,
    reference_no TEXT,
    counterparty TEXT,
    notes TEXT,
    source TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_movements_type ON stock_movements(type);
CREATE INDEX IF NOT EXISTS idx_movements_material ON stock_movements(material_id);
CREATE INDEX IF NOT EXISTS idx_movements_warehouse ON stock_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_movements_date ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_movements_source ON stock_movements(source);

-- ============================================
-- 发货单
-- ============================================
CREATE TABLE IF NOT EXISTS shipments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_no TEXT NOT NULL UNIQUE,
    customer_name TEXT,
    customer_contact TEXT,
    shipping_address TEXT,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    stock_document_id INTEGER REFERENCES stock_documents(id),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')),
    total_amount REAL DEFAULT 0,
    notes TEXT,
    shipped_at TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS shipment_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    quantity INTEGER NOT NULL,
    unit_price REAL,
    total_price REAL
);

CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_shipments_date ON shipments(created_at);
CREATE INDEX IF NOT EXISTS idx_shipments_stock_document ON shipments(stock_document_id);
CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id);

-- ============================================
-- SOP（标准操作流程）
-- ============================================
CREATE TABLE IF NOT EXISTS sops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    title_pinyin TEXT,
    title_pinyin_abbr TEXT,
    version TEXT DEFAULT '1.0',
    category TEXT,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sop_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    duration_minutes INTEGER,
    image_url TEXT,
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_sop_steps_sop ON sop_steps(sop_id);

CREATE TABLE IF NOT EXISTS sop_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sop_id INTEGER NOT NULL REFERENCES sops(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    quantity_per_unit REAL NOT NULL DEFAULT 1,
    step_id INTEGER REFERENCES sop_steps(id) ON DELETE SET NULL,
    allow_substitution INTEGER NOT NULL DEFAULT 0,
    substitution_priority INTEGER DEFAULT 1,
    notes TEXT,
    UNIQUE(sop_id, material_id, step_id)
);

-- ============================================
-- 生产工单
-- ============================================
CREATE TABLE IF NOT EXISTS production_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    sop_id INTEGER NOT NULL REFERENCES sops(id),
    output_material_id INTEGER REFERENCES materials(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    issue_document_id INTEGER REFERENCES stock_documents(id),
    receipt_document_id INTEGER REFERENCES stock_documents(id),
    return_document_id INTEGER REFERENCES stock_documents(id),
    planned_quantity INTEGER NOT NULL,
    completed_quantity INTEGER DEFAULT 0,
    returned_quantity REAL DEFAULT 0,
    status TEXT DEFAULT 'planned' CHECK(status IN ('planned', 'in_progress', 'completed', 'cancelled')),
    notes TEXT,
    snapshot_created_at TEXT,
    sop_snapshot_json TEXT,
    bom_snapshot_json TEXT,
    workorder_snapshot_json TEXT,
    substitution_plan_json TEXT,
    substitution_executed_json TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_production_status ON production_orders(status);
CREATE INDEX IF NOT EXISTS idx_production_sop ON production_orders(sop_id);
CREATE INDEX IF NOT EXISTS idx_production_issue_document ON production_orders(issue_document_id);
CREATE INDEX IF NOT EXISTS idx_production_receipt_document ON production_orders(receipt_document_id);
CREATE INDEX IF NOT EXISTS idx_production_return_document ON production_orders(return_document_id);

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

-- ============================================
-- BOM 物料清单（独立管理，支持多级）
-- ============================================
CREATE TABLE IF NOT EXISTS boms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT UNIQUE,
    version TEXT DEFAULT '1.0',
    output_material_id INTEGER REFERENCES materials(id),
    output_quantity REAL DEFAULT 1,
    category TEXT,
    description TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'draft', 'archived')),
    name_pinyin TEXT,
    name_pinyin_abbr TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    is_active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bom_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
    material_id INTEGER REFERENCES materials(id),
    sub_bom_id INTEGER REFERENCES boms(id),
    quantity REAL NOT NULL DEFAULT 1,
    position TEXT,
    loss_rate REAL DEFAULT 0,
    allow_substitution INTEGER NOT NULL DEFAULT 0,
    substitution_priority INTEGER DEFAULT 1,
    notes TEXT,
    sort_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bom_items_bom ON bom_items(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_material ON bom_items(material_id);
CREATE INDEX IF NOT EXISTS idx_bom_items_sub_bom ON bom_items(sub_bom_id);

-- BOM 版本历史
CREATE TABLE IF NOT EXISTS bom_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    change_notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_bom_versions_bom ON bom_versions(bom_id);
