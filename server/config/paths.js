const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

function resolveAppPath(targetPath, fallbackPath) {
    const value = targetPath || fallbackPath;
    return path.isAbsolute(value) ? value : path.resolve(ROOT_DIR, value);
}

function getDbPath() {
    return resolveAppPath(process.env.DB_PATH, path.join('data', 'inventory.db'));
}

function getSessionDbDir() {
    return resolveAppPath(process.env.SESSION_DB_DIR, path.dirname(getDbPath()));
}

function getSessionDbName() {
    return process.env.SESSION_DB_NAME || 'sessions.db';
}

function getSessionDbPath() {
    return path.join(getSessionDbDir(), getSessionDbName());
}

module.exports = {
    ROOT_DIR,
    getDbPath,
    getSessionDbDir,
    getSessionDbName,
    getSessionDbPath
};
