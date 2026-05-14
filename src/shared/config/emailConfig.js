const nodemailer = require('nodemailer');

// Logger utility
const emailLogger = {
  info: (message, data = {}) => {
    console.log(`[EMAIL:INFO] ${message}`, data);
  },
  warn: (message, data = {}) => {
    console.warn(`[EMAIL:WARN] ${message}`, data);
  },
  error: (message, data = {}) => {
    console.error(`[EMAIL:ERROR] ${message}`, data);
  }
};

// Email config state
let transporter = null;
let configError = null;

/**
 * Validate SMTP configuration exists
 * Returns object with { valid: boolean, errors: string[], warnings: string[] }
 */
const validateSmtpConfig = () => {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  const missing = required.filter(key => !process.env[key]);
  const errors = [];
  const warnings = [];

  // Log current environment state (mask sensitive values)
  emailLogger.info('Environment check:', {
    SMTP_HOST: process.env.SMTP_HOST ? '✓' : '✗',
    SMTP_PORT: process.env.SMTP_PORT ? '✓' : '✗',
    SMTP_USER: process.env.SMTP_USER ? '✓' : '✗',
    SMTP_PASS: process.env.SMTP_PASS ? '✓' : '✗',
    NODE_ENV: process.env.NODE_ENV
  });

  if (missing.length > 0) {
    const message = `Missing SMTP configuration: ${missing.join(', ')}`;
    errors.push(message);
    emailLogger.warn(message);
  }

  if (!process.env.SMTP_PORT) {
    warnings.push('SMTP_PORT not configured');
  } else if (isNaN(Number(process.env.SMTP_PORT))) {
    errors.push('SMTP_PORT must be a valid number');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    missing
  };
};

/**
 * Initialize email transporter (called lazily on first email send attempt)
 * This prevents crash at startup if SMTP config is missing
 */
const initializeTransporter = () => {
  if (transporter) {
    return { success: true, transporter };
  }

  const validation = validateSmtpConfig();

  if (!validation.valid) {
    configError = validation.errors.join('; ');
    emailLogger.error('Cannot initialize email service', {
      errors: validation.errors,
      missing: validation.missing
    });
    return { success: false, error: configError };
  }

  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    // Verify connection on first initialization (non-blocking)
    transporter.verify((error, success) => {
      if (error) {
        emailLogger.warn('Email transporter verify failed', {
          error: error.message,
          code: error.code
        });
      } else if (success) {
        emailLogger.info('Email transporter initialized and verified');
      }
    });

    return { success: true, transporter };
  } catch (error) {
    configError = error.message;
    emailLogger.error('Failed to initialize email transporter', {
      error: error.message
    });
    return { success: false, error: configError };
  }
};

/**
 * Get transporter or error
 * Always attempts to initialize if not already done
 */
const getTransporter = () => {
  if (transporter) {
    return transporter;
  }

  const result = initializeTransporter();
  if (!result.success) {
    throw new Error(
      `Email service unavailable: ${result.error}. ` +
      'Email features require SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to be configured.'
    );
  }
  return result.transporter;
};

/**
 * Check if email config is available
 */
const isEmailConfigAvailable = () => {
  const validation = validateSmtpConfig();
  return validation.valid;
};

/**
 * Get configuration status for diagnostics
 */
const getConfigStatus = () => {
  const validation = validateSmtpConfig();
  return {
    available: validation.valid,
    configured: validation.missing.length === 0,
    errors: validation.errors,
    warnings: validation.warnings,
    initialized: transporter !== null,
    lastError: configError
  };
};

module.exports = {
  initializeTransporter,
  getTransporter,
  isEmailConfigAvailable,
  getConfigStatus,
  validateSmtpConfig,
  emailLogger
};
