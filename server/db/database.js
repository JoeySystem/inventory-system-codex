/**
 * 数据库连接管理
 * 单例模式，整个应用共享一个数据库连接
 */

const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations');
const { getDbPath } = require('../config/paths');

const DB_PATH = getDbPath();

let db = null;

/**
 * 获取数据库连接（单例）
 */
function getDB() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        // 提升并发性能
        db.pragma('busy_timeout = 5000');
        runMigrations(db);
    }
    return db;
}

/**
 * 关闭数据库连接
 */
function closeDB() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = { getDB, closeDB };
