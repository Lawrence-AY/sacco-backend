/**
 * SECURE API RESPONSE HELPERS
 * Standardize responses and ensure data sanitization
 */

const logger = require('./logger');
const { sanitizeModel, sanitizeModels } = require('./dtos');

/**
 * Standard response structure
 */
const createResponse = (success, message, data = null, meta = {}) => {
  const response = {
    success,
    message,
    timestamp: new Date().toISOString()
  };

  if (data !== null) {
    response.data = data;
  }

  // Add metadata if provided
  if (Object.keys(meta).length > 0) {
    response.meta = meta;
  }

  return response;
};

/**
 * Success response helper
 */
const success = (res, data = null, message = 'Success', statusCode = 200, meta = {}) => {
  const response = createResponse(true, message, data, meta);

  logger.info('API Success Response', {
    statusCode,
    message,
    hasData: data !== null,
    endpoint: res.req?.originalUrl,
    method: res.req?.method
  });

  return res.status(statusCode).json(response);
};

/**
 * Error response helper
 */
const error = (res, message = 'An error occurred', statusCode = 500, details = null) => {
  const response = createResponse(false, message, details ? { details } : null);

  // Log error appropriately based on status code
  const logLevel = statusCode >= 500 ? 'error' : 'warn';

  logger[logLevel]('API Error Response', {
    statusCode,
    message,
    endpoint: res.req?.originalUrl,
    method: res.req?.method,
    hasDetails: details !== null
  });

  return res.status(statusCode).json(response);
};

/**
 * Paginated response helper
 */
const paginated = (res, data, pagination, message = 'Data retrieved successfully', meta = {}) => {
  const response = createResponse(true, message, data, {
    pagination,
    ...meta
  });

  logger.info('API Paginated Response', {
    message,
    itemCount: Array.isArray(data) ? data.length : 1,
    pagination,
    endpoint: res.req?.originalUrl
  });

  return res.status(200).json(response);
};

/**
 * Secure user response - automatically sanitizes user data
 */
const userResponse = (res, user, context = 'private', message = 'User data retrieved', statusCode = 200) => {
  const { UserDTO } = require('./dtos');

  let sanitizedUser;
  switch (context) {
    case 'public':
      sanitizedUser = UserDTO.public(user);
      break;
    case 'admin':
      sanitizedUser = UserDTO.admin(user);
      break;
    case 'private':
    default:
      sanitizedUser = UserDTO.private(user);
      break;
  }

  return success(res, sanitizedUser, message, statusCode);
};

/**
 * Secure member response
 */
const memberResponse = (res, member, requestingUser = null, context = 'basic', message = 'Member data retrieved', statusCode = 200) => {
  const { MemberDTO } = require('./dtos');

  let sanitizedMember;
  switch (context) {
    case 'full':
      sanitizedMember = MemberDTO.full(member);
      break;
    case 'basic':
    default:
      sanitizedMember = MemberDTO.basic(member, requestingUser);
      break;
  }

  return success(res, sanitizedMember, message, statusCode);
};

/**
 * Secure transaction response
 */
const transactionResponse = (res, transaction, requestingUser = null, context = 'basic', message = 'Transaction data retrieved', statusCode = 200) => {
  const { TransactionDTO } = require('./dtos');

  let sanitizedTransaction;
  switch (context) {
    case 'full':
      sanitizedTransaction = TransactionDTO.full(transaction);
      break;
    case 'basic':
    default:
      sanitizedTransaction = TransactionDTO.basic(transaction, requestingUser);
      break;
  }

  return success(res, sanitizedTransaction, message, statusCode);
};

/**
 * Secure loan response
 */
const loanResponse = (res, loan, requestingUser = null, context = 'basic', message = 'Loan data retrieved', statusCode = 200) => {
  const { LoanDTO } = require('./dtos');

  let sanitizedLoan;
  switch (context) {
    case 'full':
      sanitizedLoan = LoanDTO.full(loan);
      break;
    case 'basic':
    default:
      sanitizedLoan = LoanDTO.basic(loan, requestingUser);
      break;
  }

  return success(res, sanitizedLoan, message, statusCode);
};

/**
 * Secure list response - sanitizes arrays of data
 */
const listResponse = (res, items, dtoOptions = {}, message = 'Data retrieved successfully', pagination = null) => {
  const sanitizedItems = sanitizeModels(items, dtoOptions);

  if (pagination) {
    return paginated(res, sanitizedItems, pagination, message);
  }

  return success(res, sanitizedItems, message);
};

/**
 * Authentication success response
 */
const authSuccess = (res, user, tokens, message = 'Authentication successful') => {
  const { UserDTO } = require('./dtos');
  const sanitizedUser = UserDTO.private(user);

  // Never include sensitive token data in response body
  // Tokens should be sent via httpOnly cookies
  const responseData = {
    user: sanitizedUser,
    requiresOtp: tokens.requiresOtp || false,
    sessionId: tokens.sessionId
  };

  logger.info('Authentication Success', {
    userId: user.id,
    email: user.email,
    hasTokens: !!tokens.accessToken
  });

  return success(res, responseData, message, 200);
};

/**
 * Validation error response
 */
const validationError = (res, errors, message = 'Validation failed') => {
  logger.warn('Validation Error Response', {
    errorCount: Array.isArray(errors) ? errors.length : 1,
    endpoint: res.req?.originalUrl
  });

  return error(res, message, 400, { validationErrors: errors });
};

/**
 * Forbidden response
 */
const forbidden = (res, message = 'Access forbidden') => {
  logger.warn('Forbidden Access Attempt', {
    endpoint: res.req?.originalUrl,
    method: res.req?.method,
    ip: res.req?.ip
  });

  return error(res, message, 403);
};

/**
 * Unauthorized response
 */
const unauthorized = (res, message = 'Authentication required') => {
  logger.warn('Unauthorized Access Attempt', {
    endpoint: res.req?.originalUrl,
    method: res.req?.method,
    ip: res.req?.ip
  });

  return error(res, message, 401);
};

/**
 * Not found response
 */
const notFound = (res, resource = 'Resource', message = null) => {
  const msg = message || `${resource} not found`;

  logger.warn('Resource Not Found', {
    resource,
    endpoint: res.req?.originalUrl,
    method: res.req?.method
  });

  return error(res, msg, 404);
};

/**
 * Rate limit exceeded response
 */
const rateLimitExceeded = (res, message = 'Too many requests, please try again later') => {
  logger.warn('Rate Limit Exceeded', {
    endpoint: res.req?.originalUrl,
    method: res.req?.method,
    ip: res.req?.ip
  });

  return error(res, message, 429);
};

// Legacy class-based interface for backward compatibility
class ResponseHandler {
  static success(res, data = null, message = 'Success', statusCode = 200) {
    return success(res, data, message, statusCode);
  }

  static paginated(res, data = [], pagination = {}, message = 'Success', statusCode = 200) {
    return paginated(res, data, pagination, message);
  }

  static error(res, message = 'An error occurred', statusCode = 500, details = null) {
    return error(res, message, statusCode, details);
  }

  static validationError(res, message = 'Validation failed', errors = {}) {
    return validationError(res, errors, message);
  }

  static created(res, data, message = 'Resource created successfully') {
    return success(res, data, message, 201);
  }

  static noContent(res) {
    return res.status(204).send();
  }

  static notFound(res, message = 'Resource not found') {
    return notFound(res, 'Resource', message);
  }

  static unauthorized(res, message = 'Unauthorized access') {
    return unauthorized(res, message);
  }

  static forbidden(res, message = 'Forbidden access') {
    return forbidden(res, message);
  }
}

module.exports = {
  success,
  error,
  paginated,
  listResponse,
  userResponse,
  memberResponse,
  transactionResponse,
  loanResponse,
  authSuccess,
  validationError,
  forbidden,
  unauthorized,
  notFound,
  rateLimitExceeded,
  ResponseHandler // Legacy compatibility
};
