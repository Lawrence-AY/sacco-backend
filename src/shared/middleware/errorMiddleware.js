const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

/**
 * Async error wrapper to catch errors in async route handlers
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const redact = (value) => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.entries(value).reduce((safe, [key, item]) => {
    const lower = key.toLowerCase();
    safe[key] = ['password', 'token', 'secret', 'authorization', 'otp', 'key'].some((sensitive) => lower.includes(sensitive))
      ? '[REDACTED]'
      : redact(item);
    return safe;
  }, {});
};

const normalizeSequelizeError = (err) => {
  if (err.name === 'SequelizeValidationError') {
    return {
      statusCode: 400,
      errorCode: 'ERR_DATABASE_VALIDATION',
      message: 'Validation failed',
      details: err.errors?.map((e) => ({ field: e.path, message: e.message })) || null,
    };
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    return {
      statusCode: 409,
      errorCode: 'ERR_DUPLICATE_RESOURCE',
      message: 'Resource already exists',
      details: err.errors?.map((e) => ({ field: e.path, message: `This ${e.path} is already in use` })) || null,
    };
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return {
      statusCode: 400,
      errorCode: 'ERR_INVALID_REFERENCE',
      message: 'Invalid referenced resource',
    };
  }

  if ([
    'SequelizeConnectionError',
    'SequelizeConnectionRefusedError',
    'SequelizeHostNotFoundError',
    'SequelizeHostNotReachableError',
    'SequelizeConnectionTimedOutError',
    'SequelizeDatabaseError',
  ].includes(err.name)) {
    return {
      statusCode: err.name === 'SequelizeDatabaseError' ? 500 : 503,
      errorCode: err.name === 'SequelizeDatabaseError' ? 'ERR_DATABASE' : 'ERR_DATABASE_UNAVAILABLE',
      message: err.name === 'SequelizeDatabaseError'
        ? 'Something went wrong.'
        : 'Service temporarily unavailable',
    };
  }

  return null;
};

const normalizeError = (err) => {
  const dbError = normalizeSequelizeError(err);
  if (dbError) return dbError;

  if (err.name === 'JsonWebTokenError') {
    return { statusCode: 401, errorCode: 'ERR_INVALID_TOKEN', message: 'Invalid authentication token' };
  }

  if (err.name === 'TokenExpiredError') {
    return { statusCode: 401, errorCode: 'ERR_TOKEN_EXPIRED', message: 'Authentication token has expired' };
  }

  if (err.status === 429 || err.statusCode === 429) {
    return { statusCode: 429, errorCode: 'ERR_RATE_LIMIT', message: 'Too many requests, please try again later' };
  }

  if (err instanceof AppError || err.isOperational) {
    return {
      statusCode: err.statusCode || err.status || 500,
      errorCode: err.errorCode || 'ERR_APPLICATION',
      message: err.message || 'Something went wrong.',
      details: err.details || null,
    };
  }

  return {
    statusCode: err.statusCode || err.status || 500,
    errorCode: 'ERR_INTERNAL_SERVER',
    message: 'Something went wrong.',
  };
};

/**
 * Central error handling middleware
 * Must be the last middleware in the Express app
 */
const errorHandler = (err, req, res, next) => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const normalized = normalizeError(err);
  const statusCode = normalized.statusCode >= 400 && normalized.statusCode < 600 ? normalized.statusCode : 500;

  // Log error with full context
  logger.error('Request Error:', {
    error: {
      name: err.name,
      message: err.message,
      statusCode,
      errorCode: normalized.errorCode,
      stack: err.stack
    },
    request: {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.user?.id || null,
      userAgent: req.get('User-Agent'),
      body: redact(req.body),
      params: redact(req.params),
      query: redact(req.query)
    },
    timestamp: new Date().toISOString()
  });

  // Send error response
  const errorResponse = {
    success: false,
    message: normalized.message,
    errorCode: normalized.errorCode,
    timestamp: new Date().toISOString(),
    ...(normalized.details && { details: normalized.details }),
    ...(isDevelopment && {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack
      },
      requestId: req.id || 'unknown'
    })
  };

  res.status(statusCode).json(errorResponse);

  // Log the response
  logger.warn('Error Response Sent:', {
    statusCode,
    message: normalized.message,
    errorCode: normalized.errorCode,
    url: req.originalUrl,
    method: req.method,
    responseSize: JSON.stringify(errorResponse).length
  });
};

/**
 * 404 Not Found middleware
 * Should be placed after all routes
 */
const notFoundHandler = (req, res, next) => {
  const error = new AppError('Resource not found', 404, 'ERR_ROUTE_NOT_FOUND');

  logger.warn('Route not found:', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  next(error);
};

/**
 * Request timeout middleware
 */
const timeoutMiddleware = (req, res, next) => {
  // Set timeout for requests (30 seconds)
  req.setTimeout(30000, () => {
    logger.warn('Request timeout:', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip
    });

    if (!res.headersSent) {
      res.status(408).json({
        success: false,
        message: 'Request timeout',
        errorCode: 'ERR_REQUEST_TIMEOUT',
        timestamp: new Date().toISOString()
      });
    }
  });

  next();
};

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  timeoutMiddleware
};
