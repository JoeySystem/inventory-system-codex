const path = require('path');
const { ROOT_DIR, getDbPath } = require('../server/config/paths');

function pad(value) {
    return String(value).padStart(2, '0');
}

function formatTimestamp(date) {
    return [
        date.getFullYear(),
        '-',
        pad(date.getMonth() + 1),
        '-',
        pad(date.getDate()),
        '_',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('');
}

const configuredPort = Number(process.env.PORT || 3000);
const port = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3000;
const baseUrl = `http://127.0.0.1:${port}`;
const runDir = path.join(ROOT_DIR, 'run');

const values = {
    APP_PORT: String(port),
    APP_BASE_URL: baseUrl,
    HEALTH_URL: `${baseUrl}/api/health`,
    PID_FILE: path.join(runDir, 'ovo-system.pid'),
    DB_PATH: getDbPath(),
    DB_DIR: path.dirname(getDbPath()),
    TIMESTAMP: formatTimestamp(new Date())
};

for (const [key, value] of Object.entries(values)) {
    process.stdout.write(`${key}=${value}\n`);
}
