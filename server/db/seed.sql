-- ============================================
-- 初始数据：权限矩阵
-- ============================================

-- Admin 权限（全部功能）
INSERT OR IGNORE INTO permissions (role, resource, can_view, can_add, can_edit, can_delete) VALUES
('admin', 'materials',   1, 1, 1, 1),
('admin', 'warehouses',  1, 1, 1, 1),
('admin', 'receive',     1, 1, 1, 1),
('admin', 'issue',       1, 1, 1, 1),
('admin', 'transfer',    1, 1, 1, 1),
('admin', 'count',       1, 1, 1, 1),
('admin', 'categories',  1, 1, 1, 1),
('admin', 'shipments',   1, 1, 1, 1),
('admin', 'statistics',  1, 1, 1, 1),
('admin', 'reports',     1, 1, 1, 1),
('admin', 'sops',        1, 1, 1, 1),
('admin', 'production',  1, 1, 1, 1),
('admin', 'users',       1, 1, 1, 1),
('admin', 'boms',        1, 1, 1, 1);

-- Editor 权限（可增改，不可删）
INSERT OR IGNORE INTO permissions (role, resource, can_view, can_add, can_edit, can_delete) VALUES
('editor', 'materials',   1, 1, 1, 0),
('editor', 'warehouses',  1, 1, 1, 0),
('editor', 'receive',     1, 1, 1, 0),
('editor', 'issue',       1, 1, 1, 0),
('editor', 'transfer',    1, 1, 1, 0),
('editor', 'count',       1, 1, 1, 0),
('editor', 'categories',  1, 1, 1, 0),
('editor', 'shipments',   1, 1, 1, 0),
('editor', 'statistics',  1, 0, 0, 0),
('editor', 'reports',     1, 0, 0, 0),
('editor', 'sops',        1, 1, 1, 0),
('editor', 'production',  1, 1, 1, 0),
('editor', 'users',       0, 0, 0, 0),
('editor', 'boms',        1, 1, 1, 0);

-- Viewer 权限（只读）
INSERT OR IGNORE INTO permissions (role, resource, can_view, can_add, can_edit, can_delete) VALUES
('viewer', 'materials',   1, 0, 0, 0),
('viewer', 'warehouses',  1, 0, 0, 0),
('viewer', 'receive',     1, 0, 0, 0),
('viewer', 'issue',       1, 0, 0, 0),
('viewer', 'transfer',    1, 0, 0, 0),
('viewer', 'count',       1, 0, 0, 0),
('viewer', 'categories',  1, 0, 0, 0),
('viewer', 'shipments',   1, 0, 0, 0),
('viewer', 'statistics',  1, 0, 0, 0),
('viewer', 'reports',     1, 0, 0, 0),
('viewer', 'sops',        1, 0, 0, 0),
('viewer', 'production',  1, 0, 0, 0),
('viewer', 'users',       0, 0, 0, 0),
('viewer', 'boms',        1, 0, 0, 0);

-- ============================================
-- 默认管理员账号（密码: admin123）
-- 密码哈希在 init.js 中生成
-- ============================================

-- ============================================
-- 默认仓库
-- ============================================
INSERT OR IGNORE INTO warehouses (id, name, name_pinyin, name_pinyin_abbr, address, notes)
VALUES (1, '主仓库', 'zhucangku', 'zck', '公司总部', '默认主仓库');
