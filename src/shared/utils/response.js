/**
 * Standardized response handler
 */

class ResponseHandler {
  /**
   * Send success response
   * @param {object} res - Express response object
   * @param {*} data - Response data
   * @param {string} message - Response message
   * @param {number} statusCode - HTTP status code
   */
  static success(res, data = null, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send paginated success response
   * @param {object} res - Express response object
   * @param {*} data - Response data (array)
   * @param {object} pagination - Pagination info {page, limit, total, pages}
   * @param {string} message - Response message
   * @param {number} statusCode - HTTP status code
   */
  static paginated(res, data = [], pagination = {}, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      pagination: {
        page: pagination.page || 1,
        limit: pagination.limit || 10,
        total: pagination.total || data.length,
        pages: Math.ceil((pagination.total || data.length) / (pagination.limit || 10)),
        ...pagination
      },
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send error response
   * @param {object} res - Express response object
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {object} details - Additional error details
   */
  static error(res, message = 'An error occurred', statusCode = 500, details = null) {
    const isDevelopment = process.env.NODE_ENV === 'development';
    
    return res.status(statusCode).json({
      success: false,
      message,
      ...(details && { details }),
      ...(isDevelopment && { timestamp: new Date().toISOString() })
    });
  }

  /**
   * Send validation error response
   * @param {object} res - Express response object
   * @param {string} message - Error message
   * @param {object} errors - Validation errors object
   */
  static validationError(res, message = 'Validation failed', errors = {}) {
    return res.status(400).json({
      success: false,
      message,
      errors,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send created response (201)
   * @param {object} res - Express response object
   * @param {*} data - Created resource data
   * @param {string} message - Response message
   */
  static created(res, data, message = 'Resource created successfully') {
    return res.status(201).json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send no content response (204)
   * @param {object} res - Express response object
   */
  static noContent(res) {
    return res.status(204).send();
  }

  /**
   * Send not found response (404)
   * @param {object} res - Express response object
   * @param {string} message - Error message
   */
  static notFound(res, message = 'Resource not found') {
    return res.status(404).json({
      success: false,
      message,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send unauthorized response (401)
   * @param {object} res - Express response object
   * @param {string} message - Error message
   */
  static unauthorized(res, message = 'Unauthorized access') {
    return res.status(401).json({
      success: false,
      message,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send forbidden response (403)
   * @param {object} res - Express response object
   * @param {string} message - Error message
   */
  static forbidden(res, message = 'Forbidden access') {
    return res.status(403).json({
      success: false,
      message,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = ResponseHandler;
