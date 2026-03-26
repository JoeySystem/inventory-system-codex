/**
 * 认证路由
 * POST /api/auth/login   - 登录
 * POST /api/auth/logout  - 登出
 * GET  /api/auth/me       - 获取当前登录用户信息
 * PUT  /api/auth/password - 修改密码
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { ValidationError, AuthError } = require('../utils/errors');
const { logOperation } = require('../utils/logger');

const router = express.Router();

const ACTION_PERMISSION_FALLBACKS = {
    receive: 'warehouses',
    issue: 'warehouses',
    transfer: 'warehouses',
    count: 'warehouses'
};

function buildPermissionMap(rows) {
    const permMap = {};
    rows.forEach(p => {
        permMap[p.resource] = {
            view: !!p.can_view,
            add: !!p.can_add,
            edit: !!p.can_edit,
            delete: !!p.can_delete
        };
    });

    Object.entries(ACTION_PERMISSION_FALLBACKS).forEach(([resource, fallback]) => {
        if (!permMap[resource] && permMap[fallback]) {
            permMap[resource] = { ...permMap[fallback] };
        }
    });

    return permMap;
}

/**
 * POST /api/auth/login
 * 用户登录
 */
router.post('/login', (req, res) => {
    const { username, password } = req.body;

    // 验证输入
    if (!username || !username.trim()) {
        throw new ValidationError('请输入用户名', 'username');
    }
    if (!password) {
        throw new ValidationError('请输入密码', 'password');
    }

    const db = getDB();

    // 查找用户
    const user = db.prepare(
        'SELECT * FROM users WHERE username = ? COLLATE NOCASE'
    ).get(username.trim());

    if (!user) {
        throw new AuthError('用户名或密码错误');
    }

    // 检查账号状态
    if (!user.is_active) {
        throw new AuthError('账号已被禁用，请联系管理员');
    }

    // 验证密码
    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
        throw new AuthError('用户名或密码错误');
    }

    // 更新最后登录时间
    db.prepare(
        "UPDATE users SET last_login_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(user.id);

    // 获取用户权限
    const permissions = db.prepare(
        'SELECT * FROM permissions WHERE role = ?'
    ).all(user.role);

    // 构建权限映射
    const permMap = buildPermissionMap(permissions);

    // 保存 session
    const sessionUser = {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        permissions: permMap
    };

    req.session.regenerate((err) => {
        if (err) {
            console.error('Session regenerate 失败:', err);
            return res.status(500).json({
                success: false,
                error: {
                    code: 'AUTH_ERROR',
                    message: '登录失败，请稍后重试'
                }
            });
        }

        req.session.user = sessionUser;

        logOperation({
            userId: user.id,
            action: 'login',
            resource: 'users',
            resourceId: user.id,
            detail: `用户 ${user.username} 登录`,
            ip: req.ip
        });

        res.json({
            success: true,
            data: {
                user: sessionUser
            }
        });
    });
});

/**
 * POST /api/auth/logout
 * 用户登出
 */
router.post('/logout', (req, res) => {
    const user = req.session.user;

    if (user) {
        logOperation({
            userId: user.id,
            action: 'logout',
            resource: 'users',
            resourceId: user.id,
            detail: `用户 ${user.username} 登出`,
            ip: req.ip
        });
    }

    req.session.destroy((err) => {
        if (err) {
            console.error('Session 销毁失败:', err);
        }
        res.clearCookie('maverick.sid');
        res.json({ success: true, message: '已登出' });
    });
});

/**
 * GET /api/auth/me
 * 获取当前登录用户信息（含权限）
 */
router.get('/me', (req, res) => {
    if (!req.session.user) {
        return res.json({ success: true, data: { user: null } });
    }

    // 重新从数据库获取最新权限
    const db = getDB();
    const user = db.prepare(
        'SELECT id, username, display_name, role, is_active FROM users WHERE id = ?'
    ).get(req.session.user.id);

    if (!user || !user.is_active) {
        req.session.destroy(() => {});
        return res.json({ success: true, data: { user: null } });
    }

    const permissions = db.prepare(
        'SELECT * FROM permissions WHERE role = ?'
    ).all(user.role);

    const permMap = buildPermissionMap(permissions);

    const sessionUser = {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        permissions: permMap
    };

    // 同步更新 session
    req.session.user = sessionUser;

    res.json({
        success: true,
        data: { user: sessionUser }
    });
});

/**
 * PUT /api/auth/password
 * 修改当前用户密码
 */
router.put('/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) {
        throw new ValidationError('请输入当前密码', 'currentPassword');
    }
    if (!newPassword || newPassword.length < 6) {
        throw new ValidationError('新密码至少6个字符', 'newPassword');
    }

    const db = getDB();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

    const isValid = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!isValid) {
        throw new ValidationError('当前密码错误', 'currentPassword');
    }

    const salt = bcrypt.genSaltSync(12);
    const newHash = bcrypt.hashSync(newPassword, salt);

    db.prepare(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(newHash, user.id);

    logOperation({
        userId: user.id,
        action: 'update',
        resource: 'users',
        resourceId: user.id,
        detail: '修改密码',
        ip: req.ip
    });

    res.json({ success: true, message: '密码修改成功' });
});

module.exports = router;
