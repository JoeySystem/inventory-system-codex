/**
 * 认证中间件
 * 检查用户是否已登录
 */

const { AuthError } = require('../utils/errors');

/**
 * 要求用户已登录
 */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        throw new AuthError('请先登录');
    }
    next();
}

/**
 * 可选认证（不强制，但如果有session就附加用户信息）
 */
function optionalAuth(req, res, next) {
    // session.user 已经由 express-session 自动加载
    next();
}

module.exports = { requireAuth, optionalAuth };
