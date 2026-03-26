/**
 * 操作日志记录工具
 */

const { getDB } = require('../db/database');

/**
 * 记录操作日志
 * @param {object} params
 * @param {number} params.userId - 操作用户ID
 * @param {string} params.action - 操作类型 (create/update/delete/login/logout/export)
 * @param {string} params.resource - 资源类型 (materials/warehouses/shipments/...)
 * @param {number} [params.resourceId] - 资源ID
 * @param {string} [params.detail] - 操作详情
 * @param {string} [params.ip] - IP地址
 */
function logOperation({ userId, action, resource, resourceId = null, detail = null, ip = null }) {
    try {
        const db = getDB();
        db.prepare(`
            INSERT INTO operation_logs (user_id, action, resource, resource_id, detail, ip_address)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, action, resource, resourceId, detail, ip);
    } catch (err) {
        // 日志写入失败不应影响主业务
        console.error('操作日志写入失败:', err.message);
    }
}

module.exports = { logOperation };
