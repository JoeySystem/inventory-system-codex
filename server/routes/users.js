/**
 * 用户管理路由（仅管理员）
 * GET    /api/users       - 获取用户列表
 * POST   /api/users       - 创建用户
 * PUT    /api/users/:id   - 修改用户
 * DELETE /api/users/:id   - 删除（禁用）用户
 * PUT    /api/users/:id/reset-password - 重置用户密码
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/permission');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { logOperation } = require('../utils/logger');

const router = express.Router();

// 所有用户管理接口需要管理员权限
router.use(requireAuth, requireAdmin);

/**
 * GET /api/users
 * 获取用户列表
 */
router.get('/', (req, res) => {
    const db = getDB();
    const users = db.prepare(`
        SELECT id, username, display_name, role, is_active, last_login_at, created_at
        FROM users
        ORDER BY created_at ASC
    `).all();

    res.json({
        success: true,
        data: { users }
    });
});

/**
 * POST /api/users
 * 创建新用户
 */
router.post('/', (req, res) => {
    const { username, password, displayName, role } = req.body;

    // 验证
    if (!username || !username.trim()) {
        throw new ValidationError('请输入用户名', 'username');
    }
    if (!password || password.length < 6) {
        throw new ValidationError('密码至少6个字符', 'password');
    }
    if (!displayName || !displayName.trim()) {
        throw new ValidationError('请输入显示名称', 'displayName');
    }
    const validRoles = ['admin', 'editor', 'viewer'];
    if (role && !validRoles.includes(role)) {
        throw new ValidationError('无效的角色', 'role');
    }

    const db = getDB();

    // 检查用户名唯一
    const existing = db.prepare(
        'SELECT id FROM users WHERE username = ? COLLATE NOCASE'
    ).get(username.trim());
    if (existing) {
        throw new ConflictError('用户名已存在');
    }

    // 创建用户
    const salt = bcrypt.genSaltSync(12);
    const passwordHash = bcrypt.hashSync(password, salt);

    const result = db.prepare(`
        INSERT INTO users (username, password_hash, display_name, role)
        VALUES (?, ?, ?, ?)
    `).run(username.trim(), passwordHash, displayName.trim(), role || 'viewer');

    logOperation({
        userId: req.session.user.id,
        action: 'create',
        resource: 'users',
        resourceId: result.lastInsertRowid,
        detail: `创建用户 ${username} (${role || 'viewer'})`,
        ip: req.ip
    });

    res.status(201).json({
        success: true,
        data: {
            id: result.lastInsertRowid,
            username: username.trim(),
            displayName: displayName.trim(),
            role: role || 'viewer'
        }
    });
});

/**
 * PUT /api/users/:id
 * 修改用户信息
 */
router.put('/:id', (req, res) => {
    const { id } = req.params;
    const { displayName, role, isActive } = req.body;

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
        throw new NotFoundError('用户');
    }

    // 不允许修改自己的角色（防止管理员自降权限锁死）
    if (Number(id) === req.session.user.id && role && role !== user.role) {
        throw new ValidationError('不能修改自己的角色');
    }

    const validRoles = ['admin', 'editor', 'viewer'];
    if (role && !validRoles.includes(role)) {
        throw new ValidationError('无效的角色', 'role');
    }

    db.prepare(`
        UPDATE users SET
            display_name = COALESCE(?, display_name),
            role = COALESCE(?, role),
            is_active = COALESCE(?, is_active),
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
    `).run(
        displayName?.trim() || null,
        role || null,
        isActive !== undefined ? (isActive ? 1 : 0) : null,
        id
    );

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'users',
        resourceId: Number(id),
        detail: `修改用户 ${user.username} 信息`,
        ip: req.ip
    });

    res.json({ success: true, message: '用户信息已更新' });
});

/**
 * DELETE /api/users/:id
 * 禁用用户（软删除）
 */
router.delete('/:id', (req, res) => {
    const { id } = req.params;

    if (Number(id) === req.session.user.id) {
        throw new ValidationError('不能删除自己的账号');
    }

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
        throw new NotFoundError('用户');
    }

    db.prepare(
        "UPDATE users SET is_active = 0, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(id);

    logOperation({
        userId: req.session.user.id,
        action: 'delete',
        resource: 'users',
        resourceId: Number(id),
        detail: `禁用用户 ${user.username}`,
        ip: req.ip
    });

    res.json({ success: true, message: '用户已禁用' });
});

/**
 * PUT /api/users/:id/reset-password
 * 管理员重置用户密码
 */
router.put('/:id/reset-password', (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
        throw new ValidationError('新密码至少6个字符', 'newPassword');
    }

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) {
        throw new NotFoundError('用户');
    }

    const salt = bcrypt.genSaltSync(12);
    const hash = bcrypt.hashSync(newPassword, salt);

    db.prepare(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(hash, id);

    logOperation({
        userId: req.session.user.id,
        action: 'update',
        resource: 'users',
        resourceId: Number(id),
        detail: `重置用户 ${user.username} 密码`,
        ip: req.ip
    });

    res.json({ success: true, message: '密码已重置' });
});

module.exports = router;
