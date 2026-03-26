/**
 * 注册 OvO System 为 Windows 服务（开机自启）
 * 使用 node-windows 库
 */

const path = require('path');

try {
    const { Service } = require('node-windows');

    const svc = new Service({
        name: 'OvO System',
        description: 'OvO System 物料进销存管理系统',
        script: path.join(__dirname, '..', 'server', 'index.js'),
        nodeOptions: [],
        env: [
            { name: 'NODE_ENV', value: 'production' },
            { name: 'PORT', value: process.env.PORT || '3000' }
        ],
        // 自动重启配置
        wait: 2,          // 崩溃后等待 2 秒重启
        grow: 0.5,        // 每次重启增加 0.5 秒等待
        maxRestarts: 10    // 最多重启 10 次
    });

    svc.on('install', () => {
        console.log('[√] Windows 服务已注册: OvO System');
        console.log('[√] 正在启动服务...');
        svc.start();
    });

    svc.on('start', () => {
        console.log('[√] 服务已启动！开机将自动运行');
    });

    svc.on('alreadyinstalled', () => {
        console.log('[√] 服务已存在，跳过注册');
    });

    svc.on('error', (err) => {
        console.error('[X] 服务注册出错:', err);
    });

    svc.install();

} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        console.log('[!] node-windows 未安装，跳过服务注册');
        console.log('[!] 可手动安装: npm install node-windows');
        console.log('[!] 或使用 start.bat 手动启动');
    } else {
        console.error('[X] 错误:', e.message);
    }
    process.exit(1);
}
