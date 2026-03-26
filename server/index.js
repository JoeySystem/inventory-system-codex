/**
 * OvO System - 物料进销存管理系统
 * Express 服务器入口
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// 加载环境变量
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { getDB, closeDB } = require('./db/database');
const { getDbPath, getSessionDbDir, getSessionDbName } = require('./config/paths');
const { errorHandler } = require('./utils/errors');

// 路由
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const materialRoutes = require('./routes/materials');
const warehouseRoutes = require('./routes/warehouses');
const stockDocumentRoutes = require('./routes/stock-documents');
const shipmentRoutes = require('./routes/shipments');
const statisticsRoutes = require('./routes/statistics');
const sopRoutes = require('./routes/sops');
const productionRoutes = require('./routes/production');
const dataioRoutes = require('./routes/dataio');
const bomRoutes = require('./routes/boms');

const app = express();
const PORT = process.env.PORT || 3000;
let server = null;
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

function getGitCommit() {
    try {
        return execSync('git rev-parse --short HEAD', {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'ignore']
        }).toString().trim();
    } catch (err) {
        return process.env.APP_GIT_COMMIT || 'unknown';
    }
}

const appMeta = {
    name: packageJson.name || 'ovo-system',
    version: packageJson.version || '0.0.0',
    gitCommit: getGitCommit(),
    builtAt: new Date().toISOString()
};

function resolveTrustProxy(value) {
    if (value === undefined || value === null || value === '') {
        return false;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return 1;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    const numeric = Number(normalized);
    return Number.isNaN(numeric) ? value : numeric;
}

function resolveCookieSecure() {
    const configured = (process.env.COOKIE_SECURE || 'auto').trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(configured)) {
        return true;
    }

    if (['false', '0', 'no', 'off'].includes(configured)) {
        return false;
    }

    return 'auto';
}

// ============================================
// 中间件配置
// ============================================

// 安全头
// 注意：内网 HTTP 部署时必须关闭 HSTS 和 upgrade-insecure-requests，
// 否则浏览器会把所有 API 请求强制升级为 HTTPS，导致 "Failed to fetch"
app.use(helmet({
    // 关闭 HSTS（内网 HTTP 部署不能开，会导致浏览器强制跳 HTTPS）
    hsts: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'"
            ],
            fontSrc: [
                "'self'"
            ],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
            // 明确设为 null，覆盖 Helmet 默认添加的 upgrade-insecure-requests
            // 该指令会让浏览器把 HTTP 请求强制升级为 HTTPS，内网 HTTP 部署必须禁用
            upgradeInsecureRequests: null
        }
    }
}));

// CORS（开发环境）
if (process.env.NODE_ENV === 'development') {
    app.use(cors({ origin: true, credentials: true }));
}

app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));

// 请求体解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Session 配置（使用 SQLite 存储）
const SQLiteStore = require('connect-sqlite3')(session);
const sessionDir = getSessionDbDir();
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

app.use(session({
    store: new SQLiteStore({
        db: getSessionDbName(),
        dir: sessionDir,
        table: 'sessions'
    }),
    name: 'maverick.sid',
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: resolveCookieSecure(),
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000  // 24小时
    }
}));

// 登录接口限流（防暴力破解）
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15分钟窗口
    max: 20,                    // 最多20次尝试
    message: {
        success: false,
        error: { code: 'RATE_LIMIT', message: '登录尝试次数过多，请15分钟后再试' }
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ============================================
// 静态文件
// ============================================
app.use(express.static(path.join(__dirname, '../public')));

// ============================================
// API 路由
// ============================================
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/stock-documents', stockDocumentRoutes);
app.use('/api/shipments', shipmentRoutes);
app.use('/api/statistics', statisticsRoutes);
app.use('/api/sops', sopRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/data', dataioRoutes);
app.use('/api/boms', bomRoutes);

// ============================================
// 健康检查
// ============================================
app.get('/api/health', (req, res) => {
    try {
        const db = getDB();
        const result = db.prepare('SELECT 1 as ok').get();
        res.json({
            success: true,
            data: {
                status: 'healthy',
                database: result.ok === 1 ? 'connected' : 'error',
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            data: { status: 'unhealthy', error: err.message }
        });
    }
});

app.get('/api/meta', (req, res) => {
    res.json({
        success: true,
        data: appMeta
    });
});

// ============================================
// SPA 回退：所有非 API 路由返回 index.html
// ============================================
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return next();
    }
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ============================================
// 404 处理
// ============================================
app.use('/api/*', (req, res) => {
    res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `接口 ${req.method} ${req.originalUrl} 不存在` }
    });
});

// ============================================
// 全局错误处理
// ============================================
app.use(errorHandler);

// ============================================
// 启动服务器
// ============================================

// 检查数据库是否已初始化
const dbPath = getDbPath();
if (!fs.existsSync(dbPath)) {
    console.error('❌ 数据库文件不存在！请先运行: npm run init-db');
    process.exit(1);
}

function startServer(port = PORT) {
    if (server) {
        return server;
    }

    server = app.listen(port, () => {
    // 获取局域网 IP
        const os = require('os');
        const nets = os.networkInterfaces();
        let lanIP = '未知';
        for (const iface of Object.values(nets)) {
            for (const cfg of iface) {
                if (cfg.family === 'IPv4' && !cfg.internal) {
                    lanIP = cfg.address;
                    break;
                }
            }
            if (lanIP !== '未知') break;
        }

        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║       OvO System 物料管理系统 v1.0          ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log(`║  🌐 本机: http://localhost:${port}                ║`);
        console.log(`║  🌐 局域网: http://${lanIP}:${port}`);
        console.log(`║  📁 数据库: ${dbPath}`);
        console.log(`║  🔧 环境: ${(process.env.NODE_ENV || 'development').padEnd(33)}║`);
        console.log(`║  🍪 Cookie: ${String(resolveCookieSecure()).padEnd(31)}║`);
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
    });

    return server;
}

function stopServer() {
    if (server) {
        server.close(() => {
            closeDB();
        });
        server = null;
        return;
    }

    closeDB();
}

if (process.env.SKIP_SERVER_START !== 'true') {
    startServer(PORT);
}

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 正在关闭服务器...');
    if (server) {
        server.close(() => {
            closeDB();
            console.log('✅ 服务器已关闭');
            process.exit(0);
        });
        return;
    }
    closeDB();
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (server) {
        server.close(() => {
            closeDB();
            process.exit(0);
        });
        return;
    }
    closeDB();
    process.exit(0);
});

module.exports = { app, startServer, stopServer };
