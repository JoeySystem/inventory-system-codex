/**
 * 数据维护路由
 * 管理员专用：数据库备份、恢复、迁移包导出
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const { getDB, closeDB } = require('../db/database');
const { ROOT_DIR, getDbPath } = require('../config/paths');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/permission');
const { logOperation } = require('../utils/logger');
const { ValidationError, NotFoundError, asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

const BACKUP_DIR = path.resolve(ROOT_DIR, process.env.BACKUP_DIR || 'backups');
const RESTORE_UPLOAD_DIR = path.join(BACKUP_DIR, 'restore-uploads');
const MAX_RESTORE_SIZE = Number(process.env.MAX_RESTORE_SIZE_MB || 500) * 1024 * 1024;

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds())
    ].join('');
}

function sanitizeToken(value, fallback = 'manual') {
    return String(value || fallback)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || fallback;
}

function safeFileName(name) {
    const base = path.basename(String(name || ''));
    if (!/^[a-zA-Z0-9._-]+$/.test(base)) {
        throw new ValidationError('文件名不合法');
    }
    return base;
}

function fileSize(filePath) {
    return fs.statSync(filePath).size;
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function getGitCommit() {
    try {
        return execSync('git rev-parse --short HEAD', {
            cwd: ROOT_DIR,
            stdio: ['ignore', 'pipe', 'ignore']
        }).toString().trim();
    } catch (err) {
        return process.env.APP_GIT_COMMIT || 'unknown';
    }
}

function checkpointDatabase() {
    const db = getDB();
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
        console.warn('数据库 WAL checkpoint 跳过:', err.message);
    }
}

function validateSqliteFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new NotFoundError('数据库文件');
    }

    let db;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
        const result = db.prepare('PRAGMA integrity_check').get();
        const value = Object.values(result || {})[0];
        if (value !== 'ok') {
            throw new ValidationError(`数据库完整性检查失败：${value || 'unknown'}`);
        }
        return true;
    } catch (err) {
        if (err.isOperational) throw err;
        throw new ValidationError(`不是可用的 SQLite 数据库：${err.message}`);
    } finally {
        if (db) db.close();
    }
}

function listFilesByExt(exts) {
    ensureDir(BACKUP_DIR);
    const allowed = new Set(exts);
    return fs.readdirSync(BACKUP_DIR)
        .filter(name => allowed.has(path.extname(name).toLowerCase()))
        .map(name => {
            const filePath = path.join(BACKUP_DIR, name);
            const stat = fs.statSync(filePath);
            return {
                filename: name,
                size: stat.size,
                sizeLabel: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
                createdAt: stat.birthtime.toISOString(),
                modifiedAt: stat.mtime.toISOString()
            };
        })
        .sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

function createDatabaseBackup(reason = 'manual') {
    ensureDir(BACKUP_DIR);
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new NotFoundError('当前数据库');
    }

    checkpointDatabase();
    const backupName = `inventory-backup-${timestamp()}-${sanitizeToken(reason)}.db`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    fs.copyFileSync(dbPath, backupPath);
    validateSqliteFile(backupPath);
    removeSqliteSidecarFiles(backupPath);

    return {
        filename: backupName,
        path: backupPath,
        size: fileSize(backupPath),
        checksum: sha256File(backupPath),
        createdAt: new Date().toISOString()
    };
}

function resolveBackupFile(filename, allowedExts) {
    const safeName = safeFileName(filename);
    const filePath = path.join(BACKUP_DIR, safeName);
    if (!filePath.startsWith(BACKUP_DIR + path.sep)) {
        throw new ValidationError('文件路径不合法');
    }
    if (!allowedExts.includes(path.extname(safeName).toLowerCase())) {
        throw new ValidationError('文件类型不支持');
    }
    if (!fs.existsSync(filePath)) {
        throw new NotFoundError('备份文件');
    }
    return filePath;
}

async function createMigrationPackage() {
    ensureDir(BACKUP_DIR);
    const packageName = `ovo-migration-package-${timestamp()}.zip`;
    const packagePath = path.join(BACKUP_DIR, packageName);
    const backup = createDatabaseBackup('migration');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const manifest = {
        appName: 'OvO-Inventory-System',
        appVersion: packageJson.version || '0.0.0',
        gitCommit: getGitCommit(),
        createdAt: new Date().toISOString(),
        databaseFile: 'inventory.db',
        databaseSize: backup.size,
        databaseSha256: backup.checksum,
        note: '本迁移包只包含运行数据和迁移说明，不包含真实 .env、node_modules 或本机路径配置。'
    };
    const readme = [
        '# OvO-Inventory-System 数据迁移包',
        '',
        '## 包内文件',
        '',
        '- `inventory.db`：当前系统数据库文件。',
        '- `manifest.json`：版本、提交号、数据库校验信息。',
        '- `CHECKSUM.txt`：数据库 SHA256 校验值。',
        '',
        '## 迁移使用建议',
        '',
        '1. 在目标电脑先完成系统代码部署和依赖安装。',
        '2. 停止目标电脑上的物料系统服务。',
        '3. 备份目标电脑现有 `data/inventory.db`。',
        '4. 将本包中的 `inventory.db` 放到目标系统配置的 `DB_PATH` 位置。',
        '5. 启动物料系统，并打开 `/api/health` 检查服务是否正常。',
        '',
        '如果目标电脑已能打开系统，也可以在“系统 > 数据维护”中使用恢复功能导入数据库文件。'
    ].join('\n');

    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(packagePath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.file(backup.path, { name: 'inventory.db' });
        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
        archive.append(`inventory.db  ${backup.checksum}\n`, { name: 'CHECKSUM.txt' });
        archive.append(readme, { name: 'README-migration.md' });
        archive.finalize();
    });

    return {
        filename: packageName,
        path: packagePath,
        size: fileSize(packagePath),
        checksum: sha256File(packagePath),
        databaseBackup: backup.filename,
        createdAt: new Date().toISOString()
    };
}

function removeSqliteSidecarFiles(dbPath) {
    for (const suffix of ['-wal', '-shm']) {
        const target = `${dbPath}${suffix}`;
        if (fs.existsSync(target)) {
            fs.rmSync(target, { force: true });
        }
    }
}

const restoreUpload = multer({
    dest: RESTORE_UPLOAD_DIR,
    limits: { fileSize: MAX_RESTORE_SIZE },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.db', '.sqlite', '.sqlite3'].includes(ext)) {
            cb(null, true);
        } else {
            cb(new ValidationError('仅支持 .db、.sqlite、.sqlite3 数据库文件'));
        }
    }
});

router.get('/status', asyncHandler(async (_req, res) => {
    ensureDir(BACKUP_DIR);
    const dbPath = getDbPath();
    const dbExists = fs.existsSync(dbPath);
    res.json({
        success: true,
        data: {
            dbExists,
            dbSize: dbExists ? fileSize(dbPath) : 0,
            dbSizeLabel: dbExists ? `${(fileSize(dbPath) / 1024 / 1024).toFixed(2)} MB` : '-',
            backupDir: BACKUP_DIR,
            backups: listFilesByExt(['.db']),
            migrationPackages: listFilesByExt(['.zip'])
        }
    });
}));

router.post('/backups', asyncHandler(async (req, res) => {
    const backup = createDatabaseBackup(req.body?.reason || 'manual');
    logOperation({
        userId: req.session.user?.id,
        action: 'backup',
        resource: 'maintenance',
        detail: `创建数据库备份：${backup.filename}`,
        ip: req.ip
    });
    res.json({ success: true, data: backup });
}));

router.get('/backups/:filename/download', asyncHandler(async (req, res) => {
    const filePath = resolveBackupFile(req.params.filename, ['.db']);
    res.download(filePath, path.basename(filePath));
}));

router.post('/migration-package', asyncHandler(async (req, res) => {
    const migrationPackage = await createMigrationPackage();
    logOperation({
        userId: req.session.user?.id,
        action: 'export',
        resource: 'maintenance',
        detail: `导出数据迁移包：${migrationPackage.filename}`,
        ip: req.ip
    });
    res.download(migrationPackage.path, migrationPackage.filename);
}));

router.get('/migration-packages/:filename/download', asyncHandler(async (req, res) => {
    const filePath = resolveBackupFile(req.params.filename, ['.zip']);
    res.download(filePath, path.basename(filePath));
}));

router.post('/restore', restoreUpload.single('database'), asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new ValidationError('请先选择数据库备份文件');
    }
    if (req.body?.confirmText !== '确认恢复') {
        throw new ValidationError('恢复数据库前需要输入“确认恢复”');
    }

    const uploadPath = req.file.path;
    const dbPath = getDbPath();
    let preRestoreBackup = null;

    try {
        validateSqliteFile(uploadPath);
        preRestoreBackup = createDatabaseBackup('pre-restore');
        closeDB();

        ensureDir(path.dirname(dbPath));
        removeSqliteSidecarFiles(dbPath);
        const tempDbPath = `${dbPath}.restore-${Date.now()}.tmp`;
        fs.copyFileSync(uploadPath, tempDbPath);
        fs.renameSync(tempDbPath, dbPath);
        removeSqliteSidecarFiles(dbPath);
        validateSqliteFile(dbPath);
        getDB();

        logOperation({
            userId: req.session.user?.id,
            action: 'restore',
            resource: 'maintenance',
            detail: `恢复数据库，恢复前备份：${preRestoreBackup.filename}`,
            ip: req.ip
        });

        res.json({
            success: true,
            data: {
                restored: true,
                preRestoreBackup: preRestoreBackup.filename,
                message: '数据库已恢复。建议刷新页面并重新登录确认数据。'
            }
        });
    } catch (err) {
        if (preRestoreBackup?.path && fs.existsSync(preRestoreBackup.path)) {
            try {
                closeDB();
                fs.copyFileSync(preRestoreBackup.path, dbPath);
                removeSqliteSidecarFiles(dbPath);
                getDB();
            } catch (rollbackErr) {
                console.error('恢复失败后的回滚也失败:', rollbackErr.message);
            }
        }
        throw err;
    } finally {
        if (uploadPath && fs.existsSync(uploadPath)) {
            fs.rmSync(uploadPath, { force: true });
        }
        if (uploadPath) {
            removeSqliteSidecarFiles(uploadPath);
        }
    }
}));

module.exports = router;
