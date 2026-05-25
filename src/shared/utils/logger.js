const winston = require('winston');

// Create logs directory if it doesn't exist
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

// Add colors to winston
winston.addColors(colors);

// Define format based on environment
const isProduction = process.env.NODE_ENV === 'production';

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'key',
  'authorization',
  'cookie',
];

const redact = (value) => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.entries(value).reduce((safe, [key, item]) => {
    const lower = key.toLowerCase();
    safe[key] = SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive))
      ? '[REDACTED]'
      : redact(item);
    return safe;
  }, {});
};

const normalizeLogInput = (message, meta = {}) => {
  if (message && typeof message === 'object') {
    const { message: logMessage = 'Log event', ...rest } = message;
    return { message: logMessage, meta: redact({ ...rest, ...meta }) };
  }

  return { message, meta: redact(meta) };
};

const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.colorize({ all: !isProduction })
);

// Define transports
const transports = [
  // Console transport for all environments
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} ${level}: ${message} ${metaStr}`;
      })
    )
  }),

  // File transport for errors
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    )
  }),

  // File transport for all logs in every environment.
  new winston.transports.File({
    filename: path.join(logsDir, 'combined.log'),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    )
  })
];

// Create the logger
const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  levels,
  format,
  transports,
});

// Handle logger errors
logger.on('error', (error) => {
  console.error('Logger error:', error);
});

// Export logger methods for easy use
module.exports = {
  error: (message, meta = {}) => {
    const normalized = normalizeLogInput(message, meta);
    return logger.error(normalized.message, normalized.meta);
  },
  warn: (message, meta = {}) => {
    const normalized = normalizeLogInput(message, meta);
    return logger.warn(normalized.message, normalized.meta);
  },
  info: (message, meta = {}) => {
    const normalized = normalizeLogInput(message, meta);
    return logger.info(normalized.message, normalized.meta);
  },
  http: (message, meta = {}) => {
    const normalized = normalizeLogInput(message, meta);
    return logger.http(normalized.message, normalized.meta);
  },
  debug: (message, meta = {}) => {
    const normalized = normalizeLogInput(message, meta);
    return logger.debug(normalized.message, normalized.meta);
  },

  // Stream for Morgan HTTP logging
  stream: {
    write: (message) => {
      logger.http(message.trim());
    }
  }
};
