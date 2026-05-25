/**
 * Custom Error Classes for better error handling
 */

class AppError extends Error {
  constructor(message = 'Something went wrong.', statusCode = 500, errorCode = 'ERR_INTERNAL_SERVER', isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.status = statusCode;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message || 'Validation failed', 400, 'ERR_VALIDATION');
    this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'ERR_RESOURCE_NOT_FOUND');
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'ERR_AUTHENTICATION');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Access forbidden') {
    super(message, 403, 'ERR_AUTHORIZATION');
  }
}

class UnauthorizedError extends AuthenticationError {}

class ForbiddenError extends AuthorizationError {}

class ConflictError extends AppError {
  constructor(message = 'Conflict occurred') {
    super(message, 409, 'ERR_CONFLICT');
  }
}

class DatabaseError extends AppError {
  constructor(message = 'Database operation failed', details = null) {
    super(message, 500, 'ERR_DATABASE');
    this.details = details;
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400, 'ERR_BAD_REQUEST');
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429, 'ERR_RATE_LIMIT');
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  DatabaseError,
  BadRequestError,
  RateLimitError
};
