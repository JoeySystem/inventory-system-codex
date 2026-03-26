/**
 * 数据库初始化脚本
 * 运行方式: npm run init-db
 *
 * 功能：
 * 1. 创建所有数据表
 * 2. 插入权限矩阵
 * 3. 创建默认管理员账号
 * 4. 创建默认仓库
 */

const path = require('path');
const fs = require('fs');

// 加载环境变量
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { runMigrations } = require('./migrations');
const { getDbPath } = require('../config/paths');

const DB_PATH = getDbPath();
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const SEED_PATH = path.join(__dirname, 'seed.sql');

console.log('🔧 初始化数据库...');
console.log(`📁 数据库路径: ${DB_PATH}`);

// 确保 data 目录存在
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// 创建/连接数据库
const db = new Database(DB_PATH);

// 启用 WAL 模式
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

try {
    // 1. 执行 Schema
    console.log('📋 创建数据表...');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
    runMigrations(db);
    console.log('   ✅ 数据表创建完成');

    // 2. 执行 Seed 数据
    console.log('📋 插入初始数据...');
    const seed = fs.readFileSync(SEED_PATH, 'utf-8');
    db.exec(seed);
    console.log('   ✅ 权限矩阵已初始化');
    console.log('   ✅ 默认仓库已创建');

    // 3. 创建默认管理员账号
    const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!existingAdmin) {
        const salt = bcrypt.genSaltSync(12);
        const passwordHash = bcrypt.hashSync('admin123', salt);

        db.prepare(`
            INSERT INTO users (username, password_hash, display_name, role)
            VALUES (?, ?, ?, ?)
        `).run('admin', passwordHash, '系统管理员', 'admin');

        console.log('   ✅ 默认管理员账号已创建');
        console.log('   📌 用户名: admin');
        console.log('   📌 密码: admin123');
        console.log('   ⚠️  请登录后立即修改默认密码！');
    } else {
        console.log('   ℹ️  管理员账号已存在，跳过创建');
    }

    // 3.5 创建 AI 操作账号（供 MCP Server 使用）
    const existingAI = db.prepare('SELECT id FROM users WHERE username = ?').get('ai-operator');
    if (!existingAI) {
        const aiSalt = bcrypt.genSaltSync(12);
        const aiHash = bcrypt.hashSync('ai123456', aiSalt);
        db.prepare(`
            INSERT INTO users (username, password_hash, display_name, role)
            VALUES (?, ?, ?, ?)
        `).run('ai-operator', aiHash, 'AI助手', 'editor');
        console.log('   ✅ AI操作账号已创建 (ai-operator / ai123456)');
    } else {
        console.log('   ℹ️  AI操作账号已存在，跳过创建');
    }

    // 4. 统计
    const tableCount = db.prepare(
        "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).get();
    console.log(`\n✅ 数据库初始化完成！共 ${tableCount.cnt} 张数据表`);

} catch (err) {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
} finally {
    db.close();
}
