const fs = require('fs');
const path = require('path');

const { getDbPath, getSessionDbDir } = require('../config/paths');
const { validateSessionSecret } = require('../config/security');

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');

function parseMajor(version) {
    const match = String(version || '').match(/^v?(\d+)/);
    return match ? Number(match[1]) : NaN;
}

function canLoad(moduleName) {
    try {
        require(moduleName);
        return { ok: true };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

function printLine(label, value) {
    console.log(`${label}: ${value}`);
}

const nodeMajor = parseMajor(process.version);
const npmMajor = parseMajor(process.env.npm_config_user_agent?.match(/npm\/(\d+)/)?.[1]);
const supportedNodeMajors = new Set([20, 22, 24]);
const nodeSupported = supportedNodeMajors.has(nodeMajor);
const betterSqliteCheck = canLoad('better-sqlite3');
const dbPath = getDbPath();
const sessionDir = getSessionDbDir();
const sessionSecretValidation = validateSessionSecret(process.env.SESSION_SECRET, process.env.NODE_ENV || 'development');

console.log('=== OvO System Environment Check ===');
printLine('Node.js', process.version);
printLine('npm', Number.isNaN(npmMajor) ? 'unknown' : `v${npmMajor}`);
printLine('DB_PATH', dbPath);
printLine('SESSION_DB_DIR', sessionDir);
printLine('NODE_ENV', process.env.NODE_ENV || 'development');
printLine('COOKIE_SECURE', process.env.COOKIE_SECURE || 'auto');

const issues = [];

if (!nodeSupported) {
    issues.push(`当前 Node.js ${process.version} 不在推荐范围内，建议使用 20.x / 22.x / 24.x LTS 或稳定版`);
}

if (!betterSqliteCheck.ok) {
    issues.push(`better-sqlite3 无法加载: ${betterSqliteCheck.message}`);
}

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    issues.push(`数据库目录不存在: ${dbDir}`);
}

if (!fs.existsSync(sessionDir)) {
    issues.push(`Session 目录不存在: ${sessionDir}`);
}

if ((process.env.NODE_ENV || 'development') === 'production' && !sessionSecretValidation.valid) {
    issues.push(sessionSecretValidation.message);
}

if (issues.length === 0) {
    console.log('Environment check passed.');
    process.exit(0);
}

console.log('');
console.log('Detected issues:');
issues.forEach((issue, index) => {
    console.log(`${index + 1}. ${issue}`);
});

if (strict) {
    process.exit(1);
}

console.log('');
console.log('Warnings only. Continue with caution.');
process.exit(0);
