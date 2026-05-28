const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// NOTE: dotenv is loaded in index.js BEFORE this module is imported
// Do NOT call dotenv.config() here to avoid timing issues

const logger = require('./shared/utils/logger');
const { errorHandler, notFoundHandler, timeoutMiddleware } = require('./shared/middleware/errorMiddleware');
const auditLogger = require('./shared/middleware/auditLogger');
const security = require('./shared/config/security');
const { validate, schemas } = require('./shared/middleware/zodValidation');

// Import email config utility (for diagnostics only - validates lazily)
const { getConfigStatus } = require('./shared/config/emailConfig');

// Import database for health checks
const db = require('./models');

// Import routes
const roleRoutes = require('./features/roles/routes/roleRoutes');
const transactionRoutes = require('./features/transactions/routes/transactionRoutes');
const dividendRoutes = require('./features/dividends/routes/dividendRoutes');
const flowRoutes = require('./features/flows/routes/flowRoutes');
const authRoutes = require('./features/auth/routes/authRoutes');
const applicationRoutes = require('./features/applications/routes/applicationRoutes');
const deductionRoutes = require('./features/deductions/routes/deductionRoutes');
const loanRoutes = require('./features/loans/routes/loanRoutes');
const userRoutes = require('./features/users/routes/userRoutes');
const shareRoutes = require('./features/shares/routes/shareRoutes');
const memberRoutes = require('./features/member/routes/memberRoutes');
const financeRoutes = require('./features/finance/routes/financeRoutes');
const adminRoutes = require('./features/admin/routes/adminRoutes');
const searchRoutes = require('./features/search/routes/searchRoutes');

const applicationController = require('./features/applications/controllers/applicationController');

const { loginUser, verifyLoginOTP, refreshToken, logoutUser, registerUser, verifyOTP, resendOTP, setPassword, protect, getSessions, revokeSession } = require('./shared/middleware/authMiddleware');

const app = express();
app.locals.apiReady = false;
app.locals.apiStartupError = null;

// Railway terminates TLS and forwards the original client IP in proxy headers.
// This must be set before express-rate-limit reads req.ip.
app.set('trust proxy', 1);

const sanitizeString = (value) => value
  .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
  .replace(/javascript:/gi, '')
  .replace(/\son\w+=/gi, '');

const sanitizeInput = (value) => {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeInput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeInput(item)]));
  }
  return value;
};

const getConfiguredOrigins = () => [
  process.env.CORS_ORIGIN,
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
]
  .filter(Boolean)
  .flatMap((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean));

const allowedOrigins = [
  ...getConfiguredOrigins(),
  'http://localhost:3000',
  'http://localhost:5173',
  'https://ayedos-sacco.vercel.app',
  'https://ayedos-webapp.vercel.app'
];

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  const allowAllOrigins = process.env.NODE_ENV !== 'production' && allowedOrigins.includes('*');
  const allowVercelPreview = process.env.NODE_ENV !== 'production' && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
  return allowAllOrigins || allowVercelPreview || allowedOrigins.includes(origin);
};

const getEnvironmentDiagnostics = () => {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'NODE_ENV', 'FRONTEND_URL'];
  const optional = ['RESEND_API_KEY', 'SMTP_HOST', 'SMTP_USER'];
  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    required: Object.fromEntries(required.map((key) => [key, Boolean(process.env[key])])),
    optional: Object.fromEntries(optional.map((key) => [key, Boolean(process.env[key])])),
    railway: {
      serviceId: Boolean(process.env.RAILWAY_SERVICE_ID),
      deploymentId: Boolean(process.env.RAILWAY_DEPLOYMENT_ID),
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      publicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    }
  };
};

const isLocalRequest = (req) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

app.use((req, res, next) => {
  const requestId = req.get('X-Request-ID') || crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// ============= SECURITY MIDDLEWARE =============
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

app.use(compression());

// ============= RATE LIMITING =============
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS' || isLocalRequest(req) // Skip preflight and localhost
});

app.use('/api/', limiter);

// Stricter rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 auth requests per windowMs
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS' || isLocalRequest(req),
});

app.use([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/verify-otp',
  '/api/auth/resend-otp',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
], authLimiter);

// Stricter rate limiting for sensitive operations
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 sensitive operations per hour
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many sensitive operations, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/loans', sensitiveLimiter);
app.use('/api/transactions', sensitiveLimiter);
app.use('/api/finance', sensitiveLimiter);

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: {
    success: false,
    code: 'RATE_LIMITED',
    message: 'Too many search requests, please try again later.',
    errorCode: 'RATE_LIMITED',
    timestamp: new Date().toISOString(),
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS' || isLocalRequest(req),
});

app.use(['/api/search', '/search'], searchLimiter);

// ============= CORS =============
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);

    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      logger.warn('CORS blocked request', { origin, endpoint: 'CORS' });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Device-Id',
    'X-Device-Name',
    'X-Session-Id',
    'Accept',
    'Accept-Encoding',
    'Accept-Language'
  ],
  exposedHeaders: ['X-Total-Count', 'X-Rate-Limit-Remaining'],
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Handle preflight requests for all routes
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      logger.warn('CORS preflight blocked request', { origin, endpoint: req.originalUrl });
      return res.status(403).json({
        success: false,
        message: 'Request origin is not allowed',
        code: 'FORBIDDEN',
        timestamp: new Date().toISOString(),
      });
    }
    if (origin) res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Device-Id, X-Device-Name, X-Session-Id, Accept, Accept-Encoding, Accept-Language, X-API-Key');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '86400');
    return res.sendStatus(200);
  }
  next();
});

// Keep the HTTP server reachable while database startup work is still running.
// This prevents frontend dev proxy calls from failing with ECONNREFUSED/502.
app.use(['/api', '/search'], (req, res, next) => {
  if (app.locals.apiReady) return next();

  return res.status(503).json({
    success: false,
    message: 'Service is temporarily unavailable. Please try again later.',
    code: 'SERVER_ERROR',
    errorCode: 'SERVER_ERROR',
    requestId: req.id || 'unknown',
    timestamp: new Date().toISOString(),
  });
});

// ============= LOGGING MIDDLEWARE =============
if (process.env.NODE_ENV === 'production') {
  // Production: Use Morgan with Winston stream
  app.use(morgan('combined', {
    stream: logger.stream,
    skip: (req, res) => res.statusCode < 400 // Only log errors and above
  }));
} else {
  // Development: Log all requests
  app.use(morgan('dev', {
    stream: logger.stream
  }));
}

// ============= REQUEST LOGGING MIDDLEWARE =============
app.use((req, res, next) => {
  const start = Date.now();

  // Log request
  logger.http(`Request: ${req.method} ${req.originalUrl}`, {
    requestId: req.id,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';

    logger[level](`Response: ${req.method} ${req.originalUrl} ${res.statusCode}`, {
      requestId: req.id,
      duration: `${duration}ms`,
      ip: req.ip,
      statusCode: res.statusCode,
      timestamp: new Date().toISOString()
    });
  });

  next();
});

// ============= REQUEST TIMEOUT =============
app.use(timeoutMiddleware);

// ============= BODY PARSING MIDDLEWARE =============
app.use(express.json({
  limit: security.inputLimits.json,
  verify: (req, res, buffer) => {
    req.rawBody = buffer?.length ? buffer.toString('utf8') : '';
  }
}));
app.use(express.urlencoded({ limit: security.inputLimits.urlencoded, extended: true }));
app.use(cookieParser());
app.use((req, res, next) => {
  req.body = sanitizeInput(req.body);
  req.params = sanitizeInput(req.params);
  try {
    req.query = sanitizeInput(req.query);
  } catch (error) {
    logger.warn('Unable to sanitize query object', { error: error.message, route: req.originalUrl });
  }
  next();
});
app.use(auditLogger);

// ============= HEALTH CHECK ENDPOINTS =============

// Basic health check
app.get('/health', async (req, res) => {
  const startedAt = Date.now();
  let database = 'connected';
  let statusCode = 200;

  try {
    await db.sequelize.authenticate();
  } catch (error) {
    database = 'disconnected';
    statusCode = 503;
    logger.error('Health database check failed', {
      error: error.message,
      requestId: req.id,
    });
  }

  res.status(statusCode).json({
    success: statusCode === 200,
    status: statusCode === 200 && app.locals.apiReady ? 'healthy' : 'degraded',
    database,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    environment: getEnvironmentDiagnostics(),
    railway: getEnvironmentDiagnostics().railway,
    api: {
      ready: Boolean(app.locals.apiReady),
      startupError: app.locals.apiStartupError ? 'startup_failed' : null,
    },
    responseTimeMs: Date.now() - startedAt,
  });
});

app.get('/ready', (req, res) => {
  const ready = Boolean(app.locals.apiReady);

  res.status(ready ? 200 : 503).json({
    success: ready,
    message: ready ? 'Service is ready' : 'Service is temporarily unavailable',
    code: ready ? undefined : 'SERVER_ERROR',
    errorCode: ready ? undefined : 'SERVER_ERROR',
    timestamp: new Date().toISOString(),
  });
});

// Comprehensive health check with DB connectivity
app.get('/health/detailed', async (req, res) => {
  try {
    const startTime = Date.now();

    // Check database connectivity
    await db.sequelize.authenticate();
    const dbResponseTime = Date.now() - startTime;

    // Get database stats
    const [results] = await db.sequelize.query('SELECT version() as version');
    const dbVersion = results[0]?.version || 'unknown';

    res.status(200).json({
      success: true,
      message: 'All systems operational',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV,
      database: {
        status: 'connected',
        responseTime: `${dbResponseTime}ms`,
        version: dbVersion
      },
      memory: process.memoryUsage(),
      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version
      }
    });
  } catch (error) {
    logger.error('Health check failed:', {
      error: error.message,
      stack: error.stack
    });

    res.status(503).json({
      success: false,
      message: 'Service is temporarily unavailable',
      code: 'SERVER_ERROR',
      errorCode: 'SERVER_ERROR',
      timestamp: new Date().toISOString(),
    });
  }
});

// Railway-specific health check
app.get('/health/railway', async (req, res) => {
  try {
    // Quick DB check
    await db.sequelize.authenticate();

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime())
    });
  } catch (error) {
    logger.error('Railway health check failed:', { error: error.message });

    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      message: 'Service is temporarily unavailable',
      code: 'SERVER_ERROR',
      errorCode: 'SERVER_ERROR'
    });
  }
});

// ============= DIAGNOSTICS ENDPOINT (Dev/Staging) =============
app.get('/api/diagnostics', (req, res) => {
  // Only allow in non-production or with authorization
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      message: 'Diagnostics endpoint not available in production'
    });
  }

  const emailStatus = getConfigStatus();

  res.status(200).json({
    success: true,
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT || 3000,
      CORS_ORIGIN: process.env.CORS_ORIGIN || 'not set'
    },
    email: emailStatus,
    system: {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    },
    database: {
      dialect: db.sequelize.getDialect(),
      database: db.sequelize.config.database,
      host: db.sequelize.config.host
    }
  });
});

// ============= AUTH ROUTES =============
app.use('/api/auth', authRoutes);
app.post('/api/auth/register', validate(schemas.register), registerUser);
app.post('/api/auth/verify-otp', validate(schemas.otp), verifyOTP);
app.post('/api/auth/resend-otp', validate(schemas.emailOnly), resendOTP);
app.post('/api/auth/login', validate(schemas.login), loginUser);
app.post('/api/auth/login/verify-otp', validate(schemas.otp), verifyLoginOTP);
app.post('/api/auth/refresh', validate(schemas.refresh), refreshToken);
app.post('/api/auth/logout', protect, logoutUser);
app.post('/api/auth/set-password', setPassword);
app.get('/api/auth/sessions', protect, getSessions);
app.post('/api/auth/sessions/:sessionId/revoke', protect, revokeSession);

// ============= API ROUTES =============
app.use('/api/roles', roleRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/dividends', dividendRoutes);
app.use('/api/flows', flowRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/deductions', deductionRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/users', userRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/search', searchRoutes);
app.use('/search', searchRoutes);

// ============= STK STATUS ROUTE =============
app.get('/api/stk-status', applicationController.checkStkStatus);

// ============= GLOBAL ERROR CATCHING MIDDLEWARE =============
// This catches any errors that slip through other middleware
app.use((err, req, res, next) => {
  // If headers already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  // Log and pass through to the centralized error handler so custom error
  // classes keep their intended status codes.
  logger.error('Error forwarded to centralized handler:', {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  return next(err);
});

// ============= 404 & ERROR HANDLERS =============
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
