const fs = require('fs');
const path = require('path');

const { getDbPath, getSessionDbDir } = require('../config/paths');
const { validateSessionSecret } = require('../config/security');

function print(status, message) {
    console.log(`[${status}] ${message}`);
}

function ensureFile(filePath, label, issues) {
    if (!fs.existsSync(filePath)) {
        issues.push(`${label} 缺失: ${filePath}`);
    }
}

function ensureDir(dirPath, label, issues) {
    if (!fs.existsSync(dirPath)) {
        issues.push(`${label} 不存在: ${dirPath}`);
    }
}

function ensureWritableDir(dirPath, label, issues) {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK);
    } catch (error) {
        issues.push(`${label} 不可写: ${dirPath}`);
    }
}

function canLoad(moduleName) {
    try {
        require(moduleName);
        return true;
    } catch (error) {
        return error.message;
    }
}

function main() {
    const issues = [];
    const dbPath = getDbPath();
    const sessionDir = getSessionDbDir();
    const publicDir = path.resolve(__dirname, '../../public');
    const vendorDir = path.join(publicDir, 'vendor');

    print('INFO', `NODE_ENV=${process.env.NODE_ENV || 'development'}`);
    print('INFO', `DB_PATH=${dbPath}`);
    print('INFO', `SESSION_DB_DIR=${sessionDir}`);
    print('INFO', `COOKIE_SECURE=${process.env.COOKIE_SECURE || 'auto'}`);

    ensureDir(path.dirname(dbPath), '数据库目录', issues);
    ensureDir(sessionDir, 'Session 目录', issues);
    ensureDir(publicDir, 'public 目录', issues);
    ensureDir(vendorDir, 'vendor 目录', issues);

    if (fs.existsSync(path.dirname(dbPath))) {
        ensureWritableDir(path.dirname(dbPath), '数据库目录', issues);
    }
    if (fs.existsSync(sessionDir)) {
        ensureWritableDir(sessionDir, 'Session 目录', issues);
    }

    [
        'vue.global.prod.js',
        'vue-router.global.prod.js',
        'lucide.js',
        'chart.umd.min.js',
        'tailwindcss.browser.js'
    ].forEach(file => ensureFile(path.join(vendorDir, file), `前端运行时资源 ${file}`, issues));

    const betterSqlite = canLoad('better-sqlite3');
    if (betterSqlite !== true) {
        issues.push(`better-sqlite3 无法加载: ${betterSqlite}`);
    }

    const sqliteStore = canLoad('connect-sqlite3');
    if (sqliteStore !== true) {
        issues.push(`connect-sqlite3 无法加载: ${sqliteStore}`);
    }

    const sessionSecretValidation = validateSessionSecret(process.env.SESSION_SECRET, process.env.NODE_ENV || 'development');
    if ((process.env.NODE_ENV || 'development') === 'production' && !sessionSecretValidation.valid) {
        issues.push(sessionSecretValidation.message);
    }

    if (issues.length) {
        print('FAIL', '部署前自检未通过');
        issues.forEach(issue => print('ERROR', issue));
        process.exit(1);
    }

    print('PASS', '部署前自检通过');
}

main();
