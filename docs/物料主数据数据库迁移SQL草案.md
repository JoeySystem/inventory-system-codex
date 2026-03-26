# 物料主数据数据库迁移 SQL 草案

## 1. 文档目的

本文档提供“物料主数据改造”第一阶段的数据库迁移草案，用于指导 [schema.sql](../server/db/schema.sql) 的扩展、迁移脚本编写和上线执行。

本文档以 SQLite 为目标数据库，遵循当前项目技术栈。

## 2. 迁移原则

- 采用“新增字段/新增表优先”的兼容式迁移
- 不直接删除现有字段
- 迁移脚本可重复执行
- 所有批量回填动作需带审计日志
- 结构迁移与数据迁移分离执行

## 3. 迁移顺序

建议按以下顺序执行：

1. 备份数据库
2. 执行结构迁移
3. 初始化分类树和默认规则
4. 执行存量物料回填
5. 执行单位数据回填
6. 执行数据质量标记
7. 验证迁移结果

## 4. 迁移前备份

```sql
-- 备份由部署脚本或应用层完成，以下为说明性示例
-- sqlite3 data/inventory.db ".backup data/inventory_before_material_master_upgrade.db"
```

## 5. 结构迁移 SQL 草案

### 5.1 扩展 materials 表

```sql
ALTER TABLE materials ADD COLUMN material_type TEXT DEFAULT 'raw';
ALTER TABLE materials ADD COLUMN internal_code TEXT;
ALTER TABLE materials ADD COLUMN barcode TEXT;
ALTER TABLE materials ADD COLUMN model TEXT;
ALTER TABLE materials ADD COLUMN spec_key TEXT;

ALTER TABLE materials ADD COLUMN is_purchasable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN is_producible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN is_sellable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN default_warehouse_id INTEGER REFERENCES warehouses(id);
ALTER TABLE materials ADD COLUMN default_supplier_id INTEGER;
ALTER TABLE materials ADD COLUMN lead_time_days INTEGER DEFAULT 0;
ALTER TABLE materials ADD COLUMN min_purchase_qty REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN purchase_lot_size REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN tax_rate REAL DEFAULT 0;

ALTER TABLE materials ADD COLUMN safety_stock REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN reorder_point REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN max_stock REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN economic_order_qty REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN allow_negative_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN is_batch_tracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN is_serial_tracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN is_expiry_tracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN stock_count_cycle_days INTEGER;

ALTER TABLE materials ADD COLUMN standard_cost REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN last_purchase_price REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN avg_cost REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN cost_source TEXT DEFAULT 'manual';
ALTER TABLE materials ADD COLUMN cost_updated_at TEXT;

ALTER TABLE materials ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE materials ADD COLUMN activated_at TEXT;
ALTER TABLE materials ADD COLUMN obsolete_at TEXT;

ALTER TABLE materials ADD COLUMN default_bom_id INTEGER REFERENCES boms(id);
ALTER TABLE materials ADD COLUMN default_sop_id INTEGER REFERENCES sops(id);
ALTER TABLE materials ADD COLUMN yield_rate REAL DEFAULT 1;
ALTER TABLE materials ADD COLUMN scrap_rate REAL DEFAULT 0;
ALTER TABLE materials ADD COLUMN is_key_part INTEGER NOT NULL DEFAULT 0;

ALTER TABLE materials ADD COLUMN master_data_owner INTEGER REFERENCES users(id);
ALTER TABLE materials ADD COLUMN data_quality_status TEXT DEFAULT 'normal';
ALTER TABLE materials ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1;
```

### 5.2 新增索引

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_internal_code
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
```

### 5.3 新增分类树表

```sql
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
```

### 5.4 新增分类默认规则表

```sql
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
```

### 5.5 新增单位换算表

```sql
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
```

### 5.6 新增供应商关系表

```sql
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
```

### 5.7 新增替代料表

```sql
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
```

### 5.8 新增生命周期日志表

```sql
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
```

### 5.9 新增快照表

```sql
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
```

### 5.10 新增合并日志表

```sql
CREATE TABLE IF NOT EXISTS material_merge_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_material_id INTEGER NOT NULL REFERENCES materials(id),
    target_material_id INTEGER NOT NULL REFERENCES materials(id),
    reason TEXT,
    changed_by INTEGER REFERENCES users(id),
    changed_at TEXT DEFAULT (datetime('now', 'localtime'))
);
```

## 6. 初始化分类树 SQL 草案

```sql
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
```

## 7. 分类默认规则 SQL 草案

```sql
INSERT OR IGNORE INTO category_defaults (
    category_id,
    default_material_type,
    default_unit,
    default_safety_stock,
    default_reorder_point,
    default_max_stock,
    default_allow_negative_stock,
    default_is_batch_tracked,
    default_is_serial_tracked,
    default_is_expiry_tracked,
    default_lead_time_days,
    default_scrap_rate
)
VALUES
    (7, 'raw', 'pcs', 200, 200, 5000, 0, 0, 0, 0, 7, 0.01),
    (8, 'raw', 'pcs', 200, 200, 5000, 0, 0, 0, 0, 7, 0.01),
    (9, 'raw', 'pcs', 100, 100, 3000, 0, 0, 0, 0, 7, 0.01),
    (10, 'raw', 'pcs', 20, 20, 500, 0, 1, 0, 0, 15, 0.00),
    (11, 'consumable', 'pcs', 100, 100, 2000, 0, 0, 0, 0, 5, 0.00),
    (12, 'consumable', 'pcs', 5, 5, 200, 0, 0, 0, 0, 5, 0.00);
```

## 8. 存量数据回填 SQL 草案

### 8.1 生命周期回填

```sql
UPDATE materials
SET lifecycle_status = CASE
    WHEN is_active = 1 THEN 'active'
    ELSE 'inactive'
END,
activated_at = CASE
    WHEN is_active = 1 AND activated_at IS NULL THEN created_at
    ELSE activated_at
END;
```

### 8.2 物料类型回填

```sql
UPDATE materials
SET material_type = CASE
    WHEN category_id IN (
        SELECT id FROM categories WHERE name LIKE '%成品%'
    ) THEN 'finished'
    WHEN category_id IN (
        SELECT id FROM categories WHERE name LIKE '%半成品%'
    ) THEN 'wip'
    WHEN category_id IN (
        SELECT id FROM categories WHERE name LIKE '%螺丝%'
           OR name LIKE '%辅料%'
           OR name LIKE '%天线%'
    ) THEN 'consumable'
    ELSE 'raw'
END;
```

### 8.3 经营属性回填

```sql
UPDATE materials
SET
    is_purchasable = CASE
        WHEN material_type IN ('raw', 'consumable', 'packaging', 'spare') THEN 1
        ELSE 0
    END,
    is_producible = CASE
        WHEN material_type IN ('wip', 'finished') THEN 1
        ELSE 0
    END,
    is_sellable = CASE
        WHEN material_type = 'finished' THEN 1
        ELSE 0
    END;
```

### 8.4 库存控制回填

```sql
UPDATE materials
SET
    safety_stock = COALESCE(NULLIF(min_stock, 0), 0),
    reorder_point = COALESCE(NULLIF(min_stock, 0), 0),
    max_stock = CASE
        WHEN min_stock > 0 THEN min_stock * 5
        ELSE 0
    END,
    allow_negative_stock = 0;
```

### 8.5 成本字段回填

```sql
UPDATE materials
SET
    standard_cost = COALESCE(cost_price, 0),
    avg_cost = COALESCE(cost_price, 0),
    cost_source = 'manual',
    cost_updated_at = datetime('now', 'localtime');
```

### 8.6 规格键回填

```sql
UPDATE materials
SET spec_key = lower(
    trim(
        COALESCE(name, '') || '|' ||
        COALESCE(spec, '') || '|' ||
        COALESCE(brand, '') || '|' ||
        COALESCE(unit, '')
    )
);
```

### 8.7 单位换算回填

```sql
INSERT INTO material_uoms (material_id, uom_type, unit_name, ratio_to_base, is_default)
SELECT id, 'base', COALESCE(NULLIF(unit, ''), 'pcs'), 1, 1
FROM materials m
WHERE NOT EXISTS (
    SELECT 1 FROM material_uoms mu
    WHERE mu.material_id = m.id AND mu.uom_type = 'base' AND mu.is_default = 1
);
```

### 8.8 数据质量标记回填

```sql
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
```

## 9. 约束增强建议

SQLite 对已存在表追加复杂约束能力有限，建议通过应用层和触发器共同实现。

### 9.1 生命周期合法值检查触发器

```sql
CREATE TRIGGER IF NOT EXISTS trg_materials_lifecycle_status_check
BEFORE UPDATE OF lifecycle_status ON materials
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('draft', 'pending_review', 'active', 'frozen', 'inactive', 'obsolete')
BEGIN
    SELECT RAISE(ABORT, 'invalid lifecycle_status');
END;
```

### 9.2 禁止自身替代自身

```sql
CREATE TRIGGER IF NOT EXISTS trg_material_substitution_self_check
BEFORE INSERT ON material_substitutions
FOR EACH ROW
WHEN NEW.material_id = NEW.substitute_material_id
BEGIN
    SELECT RAISE(ABORT, 'material cannot substitute itself');
END;
```

## 10. 后续二阶段迁移建议

以下变更不建议在第一阶段直接执行，应等 API 和代码逻辑切换完成后再做：

- 将业务逻辑从 `categories` 迁移到 `material_categories`
- 将 `code` 与 `internal_code` 完成语义切换
- 增加库存批次表、序列号表、盘点单表
- 增加生产工单快照明细表
- 增加物料合并后的外键迁移工具

## 11. 迁移后校验 SQL

### 11.1 检查基础单位

```sql
SELECT COUNT(*) AS materials_without_base_uom
FROM materials m
WHERE NOT EXISTS (
    SELECT 1 FROM material_uoms mu
    WHERE mu.material_id = m.id
      AND mu.uom_type = 'base'
      AND mu.is_default = 1
);
```

### 11.2 检查生命周期空值

```sql
SELECT COUNT(*) AS invalid_lifecycle_rows
FROM materials
WHERE lifecycle_status IS NULL OR TRIM(lifecycle_status) = '';
```

### 11.3 检查物料类型空值

```sql
SELECT COUNT(*) AS invalid_material_type_rows
FROM materials
WHERE material_type IS NULL OR TRIM(material_type) = '';
```

### 11.4 检查重复内部编码

```sql
SELECT internal_code, COUNT(*) AS cnt
FROM materials
WHERE internal_code IS NOT NULL AND TRIM(internal_code) != ''
GROUP BY internal_code
HAVING COUNT(*) > 1;
```

### 11.5 检查疑似重复物料数量

```sql
SELECT data_quality_status, COUNT(*) AS cnt
FROM materials
GROUP BY data_quality_status;
```

## 12. 上线执行建议

建议采用以下执行方式：

1. 停机备份数据库
2. 执行结构迁移 SQL
3. 执行初始化数据脚本
4. 执行存量回填脚本
5. 执行迁移后校验 SQL
6. 启动兼容版应用
7. 验证新增物料、新增编辑、列表查询、导出
8. 完成后再切换前端新页面

## 13. 风险提示

- SQLite 对 `ALTER TABLE` 的复杂约束支持有限，后续如约束持续增加，建议评估迁移到更强的关系型数据库
- 当前项目已有历史脏数据，`duplicate_suspected` 命中数量可能较大
- 分类回填规则属于启发式，第一次迁移后应由业务人工复核
- 若直接切换到强校验模式，可能会暴露大量历史引用问题，建议先兼容、再收紧

## 14. 建议输出物

基于本文档，下一步应产出：

1. `server/db/migrations/001_material_master_upgrade.sql`
2. `server/db/migrations/002_material_master_backfill.sql`
3. `scripts/diagnose-material-data.js`
4. `scripts/run-material-master-migration.js`
