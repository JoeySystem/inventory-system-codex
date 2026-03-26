/**
 * 卸载 OvO System Windows 服务
 */

const path = require('path');

try {
    const { Service } = require('node-windows');

    const svc = new Service({
        name: 'OvO System',
        script: path.join(__dirname, '..', 'server', 'index.js')
    });

    svc.on('uninstall', () => {
        console.log('[√] 服务已卸载');
    });

    svc.uninstall();

} catch (e) {
    console.error('[X] 错误:', e.message);
    process.exit(1);
}
