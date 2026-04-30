const { AppError } = require('../utils/errors');

/**
 * Central error handling middleware
 * Must be the last middleware in the Express app
 */
const errorHandler = (err, req, res, next) => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Log error
  console.error('[ERROR]', {
    name: err.name,
    message: err.message,
    status: err.status || 500,
    ...(isDevelopment && { stack: err.stack })
  });

  // Default error response
  let status = err.status || 500;
  let message = err.message || 'Internal Server Error';
  let details = err.details || null;

  // Handle specific error types
  if (err.name === 'SequelizeValidationError') {
    status = 400;
    message = 'Validation error';
    details = err.errors.map(e => ({
      field: e.path,
      message: e.message
    }));
  }

  if (err.name === 'SequelizeUniqueConstraintError') {
    status = 409;
    message = 'Resource already exists';
    details = err.errors.map(e => ({
      field: e.path,
      message: `This ${e.path} is already in use`
    }));
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    status = 400;
    message = 'Invalid reference';
    details = {
      table: err.table,
      message: 'Referenced resource does not exist'
    };
  }

  if (err.name === 'JsonWebTokenError') {
    status = 401;
    message = 'Invalid token';
  }

  if (err.name === 'TokenExpiredError') {
    status = 401;
    message = 'Token has expired';
  }

  if (err.name === 'UnauthorizedError') {
    status = 401;
    message = err.message || 'Unauthorized';
  }

  if (err.name === 'ForbiddenError') {
    status = 403;
    message = err.message || 'Forbidden';
  }

  if (err.name === 'NotFoundError') {
    status = 404;
    message = err.message || 'Resource not found';
  }

  // Send error response
  res.status(status).json({
    success: false,
    message,
    ...(details && { details }),
    ...(isDevelopment && { 
      error: {
        name: err.name,
        stack: err.stack
      }
    }),
    timestamp: new Date().toISOString()
  });
};

/**
 * 404 Not Found middleware
 * Should be placed after all routes
 */
const notFoundHandler = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  });
};

module.exports = {
  errorHandler,
  notFoundHandler
};
