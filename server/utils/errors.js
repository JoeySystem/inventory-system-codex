/**
 * 自定义错误类 + 全局错误处理中间件
 */

class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = true;
    }
}

class ValidationError extends AppError {
    constructor(message, field = null) {
        super(message, 400, 'VALIDATION_ERROR');
        this.field = field;
    }
}

class NotFoundError extends AppError {
    constructor(resource = '资源') {
        super(`${resource}不存在`, 404, 'NOT_FOUND');
    }
}

class AuthError extends AppError {
    constructor(message = '请先登录') {
        super(message, 401, 'AUTH_ERROR');
    }
}

class PermissionError extends AppError {
    constructor(message = '没有操作权限') {
        super(message, 403, 'PERMISSION_ERROR');
    }
}

class ConflictError extends AppError {
    constructor(message = '数据冲突') {
        super(message, 409, 'CONFLICT_ERROR');
    }
}

/**
 * Express 全局错误处理中间件
 */
function errorHandler(err, req, res, _next) {
    // 记录错误
    if (!err.isOperational) {
        console.error('❌ 未预期的错误:', err);
    }

    const statusCode = err.statusCode || 500;
    const response = {
        success: false,
        error: {
            code: err.code || 'INTERNAL_ERROR',
            message: err.isOperational ? err.message : '服务器内部错误，请稍后重试'
        }
    };

    // 验证错误附加字段信息
    if (err.field) {
        response.error.field = err.field;
    }

    res.status(statusCode).json(response);
}

function asyncHandler(handler) {
    return function wrappedAsyncHandler(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

module.exports = {
    AppError,
    ValidationError,
    NotFoundError,
    AuthError,
    PermissionError,
    ConflictError,
    asyncHandler,
    errorHandler
};
