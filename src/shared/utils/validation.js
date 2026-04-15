const { ValidationError } = require('./errors');

/**
 * Validation utilities
 */

/**
 * Validate required fields
 * @param {object} data - Data to validate
 * @param {array} requiredFields - Array of required field names
 * @throws {ValidationError}
 */
const validateRequired = (data, requiredFields) => {
  const missingFields = requiredFields.filter(field => !data[field]);
  
  if (missingFields.length > 0) {
    throw new ValidationError(
      'Missing required fields',
      { missingFields }
    );
  }
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean}
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validate UUID format
 * @param {string} uuid - UUID to validate
 * @returns {boolean}
 */
const isValidUUID = (uuid) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
};

/**
 * Validate phone number (basic validation)
 * @param {string} phone - Phone number to validate
 * @returns {boolean}
 */
const isValidPhone = (phone) => {
  const phoneRegex = /^[+]?[(]?[0-9]{3}[)]?[-\s.]?[0-9]{3}[-\s.]?[0-9]{4,6}$/;
  return phoneRegex.test(phone.replace(/\s/g, ''));
};

/**
 * Validate numeric range
 * @param {number} value - Value to validate
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {boolean}
 */
const isInRange = (value, min, max) => {
  return value >= min && value <= max;
};

/**
 * Validate array contains allowed values
 * @param {string} value - Value to validate
 * @param {array} allowedValues - Array of allowed values
 * @returns {boolean}
 */
const isValidEnum = (value, allowedValues) => {
  return allowedValues.includes(value);
};

/**
 * Sanitize input string (remove leading/trailing whitespace)
 * @param {string} input - Input string
 * @returns {string} Sanitized string
 */
const sanitizeString = (input) => {
  if (typeof input !== 'string') return input;
  return input.trim();
};

/**
 * Validate pagination parameters
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @throws {ValidationError}
 * @returns {object} Validated pagination object
 */
const validatePagination = (page = 1, limit = 10) => {
  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  if (isNaN(pageNum) || pageNum < 1) {
    throw new ValidationError('Page must be a positive number');
  }

  if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
    throw new ValidationError('Limit must be between 1 and 100');
  }

  return { page: pageNum, limit: limitNum };
};

/**
 * Validate object structure
 * @param {object} data - Data to validate
 * @param {object} schema - Validation schema
 * @throws {ValidationError}
 * @returns {object} Validated data
 */
const validateSchema = (data, schema) => {
  const errors = {};

  for (const field in schema) {
    const rule = schema[field];
    const value = data[field];

    if (rule.required && !value) {
      errors[field] = `${field} is required`;
      continue;
    }

    if (value && rule.type) {
      if (typeof value !== rule.type) {
        errors[field] = `${field} must be of type ${rule.type}`;
      }
    }

    if (value && rule.minLength && value.length < rule.minLength) {
      errors[field] = `${field} must be at least ${rule.minLength} characters`;
    }

    if (value && rule.maxLength && value.length > rule.maxLength) {
      errors[field] = `${field} must not exceed ${rule.maxLength} characters`;
    }

    if (value && rule.enum && !isValidEnum(value, rule.enum)) {
      errors[field] = `${field} must be one of: ${rule.enum.join(', ')}`;
    }

    if (value && rule.min !== undefined && value < rule.min) {
      errors[field] = `${field} must be at least ${rule.min}`;
    }

    if (value && rule.max !== undefined && value > rule.max) {
      errors[field] = `${field} must not exceed ${rule.max}`;
    }

    if (value && rule.custom) {
      const customError = rule.custom(value);
      if (customError) {
        errors[field] = customError;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('Validation failed', errors);
  }

  return data;
};

module.exports = {
  validateRequired,
  isValidEmail,
  isValidUUID,
  isValidPhone,
  isInRange,
  isValidEnum,
  sanitizeString,
  validatePagination,
  validateSchema
};
