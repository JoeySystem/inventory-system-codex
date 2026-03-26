CREATE INDEX IF NOT EXISTS idx_materials_internal_code
ON materials(internal_code)
WHERE internal_code IS NOT NULL AND TRIM(internal_code) != '';

CREATE INDEX IF NOT EXISTS idx_materials_type ON materials(material_type);
CREATE INDEX IF NOT EXISTS idx_materials_lifecycle_status ON materials(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_materials_business_flags
ON materials(is_purchasable, is_producible, is_sellable);
CREATE INDEX IF NOT EXISTS idx_materials_quality_status ON materials(data_quality_status);
CREATE INDEX IF NOT EXISTS idx_materials_spec_key ON materials(spec_key);
CREATE INDEX IF NOT EXISTS idx_materials_default_bom ON materials(default_bom_id);
CREATE INDEX IF NOT EXISTS idx_materials_default_sop ON materials(default_sop_id);

CREATE TABLE IF NOT EXISTS material_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES material_categories(id),
    name TEXT NOT NULL,
    code TEXT,
    level INTEGER NOT NULL DEFAULT 1,
    path TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_material_categories_parent_name
ON material_categories(parent_id, name);

CREATE TABLE IF NOT EXISTS category_defaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES material_categories(id) ON DELETE CASCADE,
    default_material_type TEXT,
    default_unit TEXT,
    default_safety_stock REAL DEFAULT 0,
    default_reorder_point REAL DEFAULT 0,
    default_max_stock REAL DEFAULT 0,
    default_allow_negative_stock INTEGER NOT NULL DEFAULT 0,
    default_is_batch_tracked INTEGER NOT NULL DEFAULT 0,
    default_is_serial_tracked INTEGER NOT NULL DEFAULT 0,
    default_is_expiry_tracked INTEGER NOT NULL DEFAULT 0,
    default_lead_time_days INTEGER DEFAULT 0,
    default_scrap_rate REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_category_defaults_category
ON category_defaults(category_id);

CREATE TABLE IF NOT EXISTS material_uoms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    uom_type TEXT NOT NULL CHECK(uom_type IN ('base', 'purchase', 'production', 'sales')),
    unit_name TEXT NOT NULL,
    ratio_to_base REAL NOT NULL CHECK(ratio_to_base > 0),
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_material_uoms_material ON material_uoms(material_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_material_uoms_type_default
ON material_uoms(material_id, uom_type)
WHERE is_default = 1;

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
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_material_suppliers_material ON material_suppliers(material_id);

CREATE TABLE IF NOT EXISTS material_substitutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    substitute_material_id INTEGER NOT NULL REFERENCES materials(id),
    priority INTEGER NOT NULL DEFAULT 1,
    substitution_type TEXT NOT NULL DEFAULT 'full'
        CHECK(substitution_type IN ('full', 'temporary', 'conditional')),
    reason TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_material_substitutions_pair
ON material_substitutions(material_id, substitute_material_id);

CREATE TABLE IF NOT EXISTS material_lifecycle_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    changed_by INTEGER REFERENCES users(id),
    changed_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_material_lifecycle_logs_material
ON material_lifecycle_logs(material_id);

CREATE TABLE IF NOT EXISTS material_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    snapshot_type TEXT NOT NULL
        CHECK(snapshot_type IN ('bom', 'shipment', 'production', 'inventory_adjustment')),
    snapshot_json TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_material_snapshots_material
ON material_snapshots(material_id);

CREATE TABLE IF NOT EXISTS material_merge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_material_id INTEGER NOT NULL REFERENCES materials(id),
    target_material_id INTEGER NOT NULL REFERENCES materials(id),
    reason TEXT,
    changed_by INTEGER REFERENCES users(id),
    changed_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TRIGGER IF NOT EXISTS trg_material_substitution_self_check
BEFORE INSERT ON material_substitutions
FOR EACH ROW
WHEN NEW.material_id = NEW.substitute_material_id
BEGIN
    SELECT RAISE(ABORT, 'material cannot substitute itself');
END;

INSERT OR IGNORE INTO material_categories (id, parent_id, name, code, level, path, sort_order)
VALUES
    (1, NULL, '原材料', 'RAW', 1, '/1', 10),
    (2, NULL, '半成品', 'WIP', 1, '/2', 20),
    (3, NULL, '成品', 'FG', 1, '/3', 30),
    (4, NULL, '辅料', 'CON', 1, '/4', 40),
    (5, NULL, '包装材料', 'PKG', 1, '/5', 50),
    (6, NULL, '备件耗材', 'SPR', 1, '/6', 60),
    (7, 1, '电阻', 'RAW-RES', 2, '/1/7', 10),
    (8, 1, '电容', 'RAW-CAP', 2, '/1/8', 20),
    (9, 1, '电感', 'RAW-IND', 2, '/1/9', 30),
    (10, 1, 'PCB', 'RAW-PCB', 2, '/1/10', 40),
    (11, 4, '螺丝紧固件', 'CON-SCR', 2, '/4/11', 50),
    (12, 4, '天线辅件', 'CON-ANT', 2, '/4/12', 60);

INSERT OR IGNORE INTO category_defaults (
    category_id, default_material_type, default_unit,
    default_safety_stock, default_reorder_point, default_max_stock,
    default_allow_negative_stock, default_is_batch_tracked,
    default_is_serial_tracked, default_is_expiry_tracked,
    default_lead_time_days, default_scrap_rate
)
VALUES
    (7, 'raw', 'pcs', 200, 200, 5000, 0, 0, 0, 0, 7, 0.01),
    (8, 'raw', 'pcs', 200, 200, 5000, 0, 0, 0, 0, 7, 0.01),
    (9, 'raw', 'pcs', 100, 100, 3000, 0, 0, 0, 0, 7, 0.01),
    (10, 'raw', 'pcs', 20, 20, 500, 0, 1, 0, 0, 15, 0.00),
    (11, 'consumable', 'pcs', 100, 100, 2000, 0, 0, 0, 0, 5, 0.00),
    (12, 'consumable', 'pcs', 5, 5, 200, 0, 0, 0, 0, 5, 0.00);

UPDATE materials
SET internal_code = COALESCE(NULLIF(TRIM(internal_code), ''), code)
WHERE internal_code IS NULL OR TRIM(internal_code) = '';

UPDATE materials
SET lifecycle_status = CASE
    WHEN is_active = 1 THEN 'active'
    ELSE 'inactive'
END
WHERE lifecycle_status IS NULL OR lifecycle_status = 'draft';

UPDATE materials
SET activated_at = COALESCE(activated_at, created_at)
WHERE lifecycle_status = 'active';

UPDATE materials
SET material_type = CASE
    WHEN material_type IS NOT NULL AND TRIM(material_type) != '' AND material_type != 'raw' THEN material_type
    WHEN category_id IN (SELECT id FROM categories WHERE name LIKE '%成品%') THEN 'finished'
    WHEN category_id IN (SELECT id FROM categories WHERE name LIKE '%半成品%') THEN 'wip'
    WHEN category_id IN (SELECT id FROM categories WHERE name LIKE '%包装%') THEN 'packaging'
    WHEN category_id IN (SELECT id FROM categories WHERE name LIKE '%螺丝%' OR name LIKE '%辅料%' OR name LIKE '%天线%') THEN 'consumable'
    ELSE 'raw'
END;

UPDATE materials
SET
    is_purchasable = CASE WHEN material_type IN ('raw', 'consumable', 'packaging', 'spare') THEN 1 ELSE is_purchasable END,
    is_producible = CASE WHEN material_type IN ('wip', 'finished') THEN 1 ELSE is_producible END,
    is_sellable = CASE WHEN material_type = 'finished' THEN 1 ELSE is_sellable END,
    safety_stock = CASE WHEN COALESCE(safety_stock, 0) = 0 THEN COALESCE(min_stock, 0) ELSE safety_stock END,
    reorder_point = CASE WHEN COALESCE(reorder_point, 0) = 0 THEN COALESCE(min_stock, 0) ELSE reorder_point END,
    standard_cost = CASE WHEN COALESCE(standard_cost, 0) = 0 THEN COALESCE(cost_price, 0) ELSE standard_cost END,
    avg_cost = CASE WHEN COALESCE(avg_cost, 0) = 0 THEN COALESCE(cost_price, 0) ELSE avg_cost END,
    cost_updated_at = COALESCE(cost_updated_at, datetime('now', 'localtime')),
    spec_key = lower(trim(COALESCE(name, '') || '|' || COALESCE(spec, '') || '|' || COALESCE(brand, '') || '|' || COALESCE(unit, '')))
WHERE 1 = 1;

INSERT INTO material_uoms (material_id, uom_type, unit_name, ratio_to_base, is_default)
SELECT m.id, 'base', COALESCE(NULLIF(m.unit, ''), 'pcs'), 1, 1
FROM materials m
WHERE NOT EXISTS (
    SELECT 1 FROM material_uoms mu
    WHERE mu.material_id = m.id
      AND mu.uom_type = 'base'
      AND mu.is_default = 1
);

UPDATE materials
SET data_quality_status = CASE
    WHEN name IS NULL OR TRIM(name) = '' THEN 'incomplete'
    WHEN unit IS NULL OR TRIM(unit) = '' THEN 'incomplete'
    WHEN EXISTS (
        SELECT 1
        FROM materials m2
        WHERE m2.id != materials.id
          AND COALESCE(m2.spec_key, '') = COALESCE(materials.spec_key, '')
          AND COALESCE(m2.spec_key, '') != ''
    ) THEN 'duplicate_suspected'
    ELSE 'normal'
END;
