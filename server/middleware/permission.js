/**
 * 权限检查中间件
 * 基于角色-资源矩阵进行权限验证
 */

const { getDB } = require('../db/database');
const { PermissionError } = require('../utils/errors');

const RESOURCE_FALLBACKS = {
    receive: ['warehouses'],
    issue: ['warehouses'],
    transfer: ['warehouses'],
    count: ['warehouses']
};

function hasPermission(db, role, resource, action) {
    const resources = [resource, ...(RESOURCE_FALLBACKS[resource] || [])];
    const fieldName = `can_${action}`;

    return resources.some(item => {
        const perm = db.prepare(
            'SELECT * FROM permissions WHERE role = ? AND resource = ?'
        ).get(role, item);
        return !!(perm && perm[fieldName]);
    });
}

/**
 * 检查用户是否有指定资源的指定操作权限
 * @param {string} resource - 资源类型 (materials/warehouses/shipments/...)
 * @param {string} action - 操作类型 (view/add/edit/delete)
 */
function requirePermission(resource, action) {
    return (req, res, next) => {
        const user = req.session.user;
        if (!user) {
            throw new PermissionError('请先登录');
        }

        const db = getDB();
        if (!hasPermission(db, user.role, resource, action)) {
            throw new PermissionError(`没有${getActionName(action)}${getResourceName(resource)}的权限`);
        }

        next();
    };
}

/**
 * 检查用户是否为管理员
 */
function requireAdmin(req, res, next) {
    const user = req.session.user;
    if (!user || user.role !== 'admin') {
        throw new PermissionError('需要管理员权限');
    }
    next();
}

function getActionName(action) {
    const map = { view: '查看', add: '添加', edit: '修改', delete: '删除' };
    return map[action] || action;
}

function getResourceName(resource) {
    const map = {
        materials: '物料',
        warehouses: '仓库',
        receive: '收货入库',
        issue: '发料出库',
        transfer: '仓间调拨',
        count: '盘点调整',
        categories: '分类',
        shipments: '发货单',
        statistics: '统计',
        reports: '报表',
        sops: 'SOP',
        production: '生产工单',
        users: '用户'
    };
    return map[resource] || resource;
}

module.exports = { requirePermission, requireAdmin, hasPermission };
