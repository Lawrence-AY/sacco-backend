/**
 * SECURE INPUT VALIDATION MIDDLEWARE
 * Comprehensive input sanitization and validation
 */

const validator = require('validator');
const logger = require('./logger');

/**
 * Sanitization rules for different data types
 */
const sanitizers = {
  // String sanitization
  string: (value) => {
    if (typeof value !== 'string') return value;
    return validator.escape(value.trim());
  },

  // Email sanitization
  email: (value) => {
    if (typeof value !== 'string') return value;
    return validator.normalizeEmail(value, {
      gmail_remove_dots: false,
      gmail_remove_subaddress: false,
      outlookdotcom_remove_subaddress: false,
      yahoo_remove_subaddress: false,
      icloud_remove_subaddress: false
    });
  },

  // Phone number sanitization
  phone: (value) => {
    if (typeof value !== 'string') return value;
    // Remove all non-digit characters except +
    return value.replace(/[^\d+]/g, '');
  },

  // Numeric sanitization
  number: (value) => {
    const num = Number(value);
    return isNaN(num) ? value : num;
  },

  // Boolean sanitization
  boolean: (value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
    }
    return Boolean(value);
  },

  // Array sanitization
  array: (value, itemSanitizer = null) => {
    if (!Array.isArray(value)) return value;
    return itemSanitizer ? value.map(itemSanitizer) : value;
  },

  // Object sanitization
  object: (value, schema = {}) => {
    if (typeof value !== 'object' || value === null) return value;
    const sanitized = {};

    Object.keys(schema).forEach(key => {
      if (value[key] !== undefined) {
        const sanitizer = schema[key];
        sanitized[key] = typeof sanitizer === 'function'
          ? sanitizer(value[key])
          : value[key];
      }
    });

    return sanitized;
  }
};

/**
 * Validation rules
 */
const validators = {
  required: (value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  },

  email: (value) => {
    if (typeof value !== 'string') return false;
    return validator.isEmail(value);
  },

  phone: (value) => {
    if (typeof value !== 'string') return false;
    // Kenyan phone number validation
    const kenyaPhoneRegex = /^(\+254|254|0)[17]\d{8}$/;
    return kenyaPhoneRegex.test(value.replace(/\s+/g, ''));
  },

  minLength: (min) => (value) => {
    if (typeof value !== 'string' && !Array.isArray(value)) return false;
    return value.length >= min;
  },

  maxLength: (max) => (value) => {
    if (typeof value !== 'string' && !Array.isArray(value)) return false;
    return value.length <= max;
  },

  numeric: (value) => {
    return !isNaN(value) && !isNaN(parseFloat(value));
  },

  integer: (value) => {
    return Number.isInteger(Number(value));
  },

  positive: (value) => {
    const num = Number(value);
    return !isNaN(num) && num > 0;
  },

  range: (min, max) => (value) => {
    const num = Number(value);
    return !isNaN(num) && num >= min && num <= max;
  },

  in: (allowedValues) => (value) => {
    return allowedValues.includes(value);
  },

  pattern: (regex) => (value) => {
    if (typeof value !== 'string') return false;
    return regex.test(value);
  },

  url: (value) => {
    if (typeof value !== 'string') return false;
    return validator.isURL(value, {
      protocols: ['http', 'https'],
      require_protocol: true
    });
  },

  strongPassword: (value) => {
    if (typeof value !== 'string') return false;
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special char
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    return strongPasswordRegex.test(value);
  },

  nationalId: (value) => {
    if (typeof value !== 'string') return false;
    // Kenyan National ID validation (6-8 digits)
    const nationalIdRegex = /^\d{6,8}$/;
    return nationalIdRegex.test(value.replace(/\s+/g, ''));
  },

  kraPin: (value) => {
    if (typeof value !== 'string') return false;
    // Kenyan KRA PIN format: A followed by 9 digits and a letter
    const kraPinRegex = /^A\d{9}[A-Z]$/;
    return kraPinRegex.test(value.toUpperCase().replace(/\s+/g, ''));
  }
};

/**
 * Validate a single field
 */
const validateField = (value, rules, fieldName) => {
  const errors = [];

  for (const rule of rules) {
    let ruleName, ruleParams;

    if (typeof rule === 'string') {
      ruleName = rule;
      ruleParams = [];
    } else if (typeof rule === 'function') {
      // Custom validation function
      try {
        const result = rule(value);
        if (result !== true) {
          errors.push(result || `${fieldName} validation failed`);
        }
      } catch (error) {
        errors.push(`${fieldName}: ${error.message}`);
      }
      continue;
    } else {
      ruleName = rule.name || rule.type;
      ruleParams = rule.params || [];
    }

    const validatorFn = validators[ruleName];
    if (!validatorFn) {
      errors.push(`${fieldName}: Unknown validation rule '${ruleName}'`);
      continue;
    }

    let isValid;
    try {
      isValid = validatorFn(...ruleParams)(value);
    } catch (error) {
      isValid = validatorFn(value);
    }

    if (!isValid) {
      let message = rule.message || `${fieldName} failed ${ruleName} validation`;
      if (ruleName === 'minLength') message = `${fieldName} must be at least ${ruleParams[0]} characters`;
      if (ruleName === 'maxLength') message = `${fieldName} must be at most ${ruleParams[0]} characters`;
      if (ruleName === 'range') message = `${fieldName} must be between ${ruleParams[0]} and ${ruleParams[1]}`;
      if (ruleName === 'in') message = `${fieldName} must be one of: ${ruleParams[0].join(', ')}`;

      errors.push(message);
    }
  }

  return errors;
};

/**
 * Validate an entire object against a schema
 */
const validateObject = (data, schema) => {
  const errors = {};
  const sanitized = {};

  for (const [fieldName, fieldConfig] of Object.entries(schema)) {
    const value = data[fieldName];
    const { rules = [], sanitize, required = false, default: defaultValue } = fieldConfig;

    // Handle default values
    let finalValue = value;
    if (finalValue === undefined && defaultValue !== undefined) {
      finalValue = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
    }

    // Check required fields
    if (required && (finalValue === null || finalValue === undefined || finalValue === '')) {
      errors[fieldName] = [`${fieldName} is required`];
      continue;
    }

    // Skip validation if field is not required and not provided
    if (!required && (finalValue === null || finalValue === undefined)) {
      continue;
    }

    // Sanitize value
    if (sanitize) {
      if (typeof sanitize === 'string') {
        finalValue = sanitizers[sanitize](finalValue);
      } else if (typeof sanitize === 'function') {
        finalValue = sanitize(finalValue);
      }
    }

    // Validate field
    const fieldErrors = validateField(finalValue, rules, fieldName);
    if (fieldErrors.length > 0) {
      errors[fieldName] = fieldErrors;
    }

    // Store sanitized value
    sanitized[fieldName] = finalValue;
  }

  return { isValid: Object.keys(errors).length === 0, errors, sanitized };
};

/**
 * Express middleware for request validation
 */
const validateRequest = (schema, source = 'body') => {
  return (req, res, next) => {
    const data = req[source];
    const { isValid, errors, sanitized } = validateObject(data, schema);

    if (!isValid) {
      logger.warn('Request validation failed', {
        endpoint: req.originalUrl,
        method: req.method,
        errors,
        ip: req.ip
      });

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors,
        timestamp: new Date().toISOString()
      });
    }

    // Replace request data with sanitized data
    req[source] = sanitized;
    next();
  };
};

/**
 * Common validation schemas
 */
const schemas = {
  userRegistration: {
    firstName: { rules: ['required', { name: 'maxLength', params: [50] }], sanitize: 'string' },
    lastName: { rules: ['required', { name: 'maxLength', params: [50] }], sanitize: 'string' },
    email: { rules: ['required', 'email'], sanitize: 'email' },
    phone: { rules: ['required', 'phone'], sanitize: 'phone' },
    password: { rules: ['required', 'strongPassword'], sanitize: 'string' },
    nationalId: { rules: ['required', 'nationalId'], sanitize: 'string' },
    kraPin: { rules: ['required', 'kraPin'], sanitize: 'string' },
    occupation: { rules: [{ name: 'maxLength', params: [100] }], sanitize: 'string' },
    address: { rules: [{ name: 'maxLength', params: [255] }], sanitize: 'string' }
  },

  userLogin: {
    email: { rules: ['required', 'email'], sanitize: 'email' },
    password: { rules: ['required'], sanitize: 'string' }
  },

  passwordReset: {
    email: { rules: ['required', 'email'], sanitize: 'email' }
  },

  passwordUpdate: {
    currentPassword: { rules: ['required'], sanitize: 'string' },
    newPassword: { rules: ['required', 'strongPassword'], sanitize: 'string' },
    confirmPassword: { rules: ['required'], sanitize: 'string' }
  },

  otpVerification: {
    otp: { rules: ['required', { name: 'pattern', params: [/^\d{6}$/] }], sanitize: 'string' }
  },

  loanApplication: {
    amount: { rules: ['required', 'positive', { name: 'range', params: [1000, 1000000] }], sanitize: 'number' },
    term: { rules: ['required', 'positive', { name: 'range', params: [1, 60] }], sanitize: 'number' },
    purpose: { rules: ['required', { name: 'maxLength', params: [500] }], sanitize: 'string' }
  },

  transaction: {
    amount: { rules: ['required', 'positive'], sanitize: 'number' },
    type: { rules: ['required', { name: 'in', params: [['deposit', 'withdrawal', 'transfer']] }], sanitize: 'string' },
    description: { rules: [{ name: 'maxLength', params: [255] }], sanitize: 'string' }
  }
};

module.exports = {
  validateRequest,
  validateObject,
  validateField,
  sanitizers,
  validators,
  schemas
};