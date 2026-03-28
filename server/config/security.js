const FALLBACK_SESSION_SECRET = 'local-dev-only-change-me';

function isInsecureSessionSecret(secret) {
    const value = String(secret || '').trim();
    if (!value) return true;

    const normalized = value.toLowerCase();
    if (
        value === FALLBACK_SESSION_SECRET ||
        normalized.includes('change-me') ||
        normalized.includes('fallback-secret') ||
        normalized.includes('test-session-secret') ||
        normalized.includes('admin123')
    ) {
        return true;
    }

    return value.length < 24;
}

function validateSessionSecret(secret, nodeEnv = process.env.NODE_ENV || 'development') {
    const insecure = isInsecureSessionSecret(secret);
    return {
        valid: !insecure,
        insecure,
        requiredInEnv: nodeEnv === 'production',
        message: insecure
            ? 'SESSION_SECRET 未配置或强度过弱，请在 .env 中设置一段长度至少 24 位的随机字符串'
            : ''
    };
}

module.exports = {
    FALLBACK_SESSION_SECRET,
    isInsecureSessionSecret,
    validateSessionSecret
};
