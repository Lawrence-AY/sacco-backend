/**
 * SECURITY CONFIGURATION
 * Centralized security settings for the SACCO management system
 */

const crypto = require('crypto');

// Environment-based security configuration
const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// JWT Configuration
const jwtConfig = {
  secret: process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex'),
  refreshSecret: process.env.JWT_REFRESH_SECRET || crypto.randomBytes(64).toString('hex'),
  expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  issuer: 'ayedos-sacco-backend',
  audience: 'ayedos-sacco-frontend'
};

// Password Policy
const passwordPolicy = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  preventCommonPasswords: true,
  commonPasswords: [
    'password', '123456', '123456789', 'qwerty', 'abc123',
    'password123', 'admin', 'letmein', 'welcome', 'monkey'
  ]
};

// Rate Limiting Configuration
const rateLimits = {
  general: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProduction ? 100 : 1000,
    message: 'Too many requests from this IP, please try again later.'
  },
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: isProduction ? 5 : 20,
    message: 'Too many authentication attempts, please try again later.'
  },
  sensitive: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: isProduction ? 10 : 50,
    message: 'Too many sensitive operations, please try again later.'
  },
  api: {
    windowMs: 60 * 1000, // 1 minute
    max: isProduction ? 30 : 100,
    message: 'API rate limit exceeded.'
  }
};

// CORS Configuration
const corsConfig = {
  allowedOrigins: [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    ...(isDevelopment ? [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173'
    ] : [])
  ].filter(Boolean),

  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],

  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Device-Id',
    'X-Device-Name',
    'X-Session-Id',
    'Accept',
    'Accept-Encoding',
    'Accept-Language',
    'X-API-Key'
  ],

  exposedHeaders: ['X-Total-Count', 'X-Rate-Limit-Remaining', 'X-Request-ID'],

  credentials: true,
  maxAge: 86400 // 24 hours
};

// Helmet Security Headers
const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'", "https:"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: 'deny' },
  ieNoOpen: true,
  dnsPrefetchControl: { allow: false }
};

// Session Configuration
const sessionConfig = {
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxConcurrentSessions: isProduction ? 3 : 10,
  cleanupInterval: 60 * 60 * 1000, // 1 hour
  requireMFA: isProduction // Require MFA in production
};

// Input Validation Limits
const inputLimits = {
  json: '10kb',
  urlencoded: '10kb',
  text: '1mb',
  file: '5mb',
  maxArraySize: 100,
  maxObjectDepth: 5,
  maxStringLength: 10000
};

// Security Headers for API Responses
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

// Audit Logging Configuration
const auditConfig = {
  enabled: true,
  logLevel: isProduction ? 'info' : 'debug',
  sensitiveFields: [
    'password', 'otp', 'token', 'secret', 'key',
    'ssn', 'socialSecurity', 'creditCard', 'bankAccount'
  ],
  excludeEndpoints: ['/health', '/health/detailed', '/health/railway'],
  maxLogSize: '10m',
  maxFiles: 5
};

// Encryption Configuration
const encryptionConfig = {
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  tagLength: 16,
  saltRounds: 12
};

// OTP Configuration
const otpConfig = {
  length: 6,
  expiresIn: 10 * 60 * 1000, // 10 minutes
  maxAttempts: isProduction ? 3 : 5,
  cooldownPeriod: 60 * 1000, // 1 minute
  resendLimit: isProduction ? 3 : 10,
  resendCooldown: 2 * 60 * 1000 // 2 minutes
};

// File Upload Security
const fileUploadConfig = {
  allowedTypes: [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain'
  ],
  maxFileSize: 5 * 1024 * 1024, // 5MB
  maxFiles: 5,
  uploadDir: 'uploads/',
  quarantineDir: 'uploads/quarantine/',
  virusScan: isProduction, // Enable virus scanning in production
  allowedExtensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.txt']
};

// Database Security
const dbSecurityConfig = {
  maxConnections: isProduction ? 20 : 10,
  connectionTimeout: 10000,
  queryTimeout: 30000,
  ssl: isProduction ? { rejectUnauthorized: true } : false,
  pool: {
    max: isProduction ? 20 : 10,
    min: 2,
    acquire: 30000,
    idle: 10000
  }
};

// Export configuration
module.exports = {
  jwt: jwtConfig,
  password: passwordPolicy,
  rateLimits,
  cors: corsConfig,
  helmet: helmetConfig,
  session: sessionConfig,
  inputLimits,
  securityHeaders,
  audit: auditConfig,
  encryption: encryptionConfig,
  otp: otpConfig,
  fileUpload: fileUploadConfig,
  database: dbSecurityConfig,
  isProduction,
  isDevelopment
};