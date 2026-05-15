/**
 * SECURE AUTHENTICATION & AUTHORIZATION MIDDLEWARE
 * JWT authentication with Role-Based Access Control (RBAC)
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { User, LoginSession } = require('../../models');
const { unauthorized, forbidden, error } = require('../utils/response');

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m'; // 15 minutes
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d'; // 7 days

// Role hierarchy (higher number = more permissions)
const ROLE_HIERARCHY = {
  MEMBER: 1,
  FINANCE: 2,
  ADMIN: 3,
  SUPERADMIN: 4
};

// Role permissions mapping
const ROLE_PERMISSIONS = {
  MEMBER: [
    'read:own_profile',
    'update:own_profile',
    'read:own_transactions',
    'read:own_loans',
    'create:loan_application',
    'create:transaction'
  ],
  FINANCE: [
    'read:own_profile',
    'update:own_profile',
    'read:all_members',
    'read:all_transactions',
    'read:all_loans',
    'update:transaction_status',
    'update:loan_status',
    'create:transaction',
    'read:financial_reports'
  ],
  ADMIN: [
    'read:own_profile',
    'update:own_profile',
    'read:all_members',
    'create:member',
    'update:member',
    'delete:member',
    'read:all_transactions',
    'read:all_loans',
    'update:transaction_status',
    'update:loan_status',
    'read:admin_reports',
    'manage:settings',
    'read:audit_logs'
  ],
  SUPERADMIN: [
    'read:own_profile',
    'update:own_profile',
    'read:all_members',
    'create:member',
    'update:member',
    'delete:member',
    'read:all_transactions',
    'read:all_loans',
    'update:transaction_status',
    'update:loan_status',
    'read:admin_reports',
    'manage:settings',
    'read:audit_logs',
    'manage:users',
    'manage:roles',
    'system:maintenance'
  ]
};

/**
 * Generate access token
 */
const generateAccessToken = (user) => {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    type: 'access',
    iat: Math.floor(Date.now() / 1000)
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

/**
 * Generate refresh token
 */
const generateRefreshToken = (user) => {
  const payload = {
    userId: user.id,
    type: 'refresh',
    iat: Math.floor(Date.now() / 1000)
  };

  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
};

/**
 * Hash password
 */
const hashPassword = async (password) => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

/**
 * Verify password
 */
const verifyPassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

/**
 * Generate OTP
 */
const generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

/**
 * Hash OTP for storage
 */
const hashOTP = (otp) => {
  return crypto.createHash('sha256').update(otp).digest('hex');
};

/**
 * Verify OTP
 */
const verifyOTP = (otp, hash) => {
  const hashedOTP = hashOTP(otp);
  return hashedOTP === hash;
};

/**
 * Create login session
 */
const createLoginSession = async (userId, userAgent, ipAddress) => {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await LoginSession.create({
    id: sessionId,
    userId,
    userAgent: userAgent || 'Unknown',
    ipAddress: ipAddress || 'Unknown',
    expiresAt,
    isActive: true
  });

  return sessionId;
};

/**
 * Invalidate login session
 */
const invalidateLoginSession = async (sessionId) => {
  await LoginSession.update(
    { isActive: false },
    { where: { id: sessionId } }
  );
};

/**
 * JWT Authentication Middleware
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.accessToken;

    if (!token) {
      return unauthorized(res, 'Access token required');
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type !== 'access') {
      return unauthorized(res, 'Invalid token type');
    }

    // Check if user still exists and is active
    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return unauthorized(res, 'User not found');
    }

    // Check if session is still active
    const session = await LoginSession.findOne({
      where: {
        userId: user.id,
        isActive: true,
        expiresAt: { [require('sequelize').Op.gt]: new Date() }
      }
    });

    if (!session) {
      return unauthorized(res, 'Session expired');
    }

    // Attach user and session to request
    req.user = user;
    req.session = session;
    next();

  } catch (err) {
    logger.warn('Authentication failed', {
      error: err.message,
      endpoint: req.originalUrl,
      ip: req.ip
    });

    if (err.name === 'TokenExpiredError') {
      return unauthorized(res, 'Token expired');
    }

    if (err.name === 'JsonWebTokenError') {
      return unauthorized(res, 'Invalid token');
    }

    return unauthorized(res, 'Authentication failed');
  }
};

/**
 * Optional authentication middleware (doesn't fail if no token)
 */
const optionalAuthenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.accessToken;

    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);

      if (decoded.type === 'access') {
        const user = await User.findByPk(decoded.userId);
        const session = await LoginSession.findOne({
          where: {
            userId: user?.id,
            isActive: true,
            expiresAt: { [require('sequelize').Op.gt]: new Date() }
          }
        });

        if (user && session) {
          req.user = user;
          req.session = session;
        }
      }
    }

    next();
  } catch (err) {
    // Silently fail for optional auth
    next();
  }
};

/**
 * Role-Based Access Control Middleware
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return unauthorized(res, 'Authentication required');
    }

    const userRole = req.user.role;
    const hasPermission = allowedRoles.some(role => {
      // Check exact role match
      if (role === userRole) return true;

      // Check role hierarchy (higher roles can access lower role resources)
      const userLevel = ROLE_HIERARCHY[userRole] || 0;
      const requiredLevel = ROLE_HIERARCHY[role] || 0;
      return userLevel >= requiredLevel;
    });

    if (!hasPermission) {
      logger.warn('Authorization failed', {
        userId: req.user.id,
        userRole,
        requiredRoles: allowedRoles,
        endpoint: req.originalUrl
      });

      return forbidden(res, 'Insufficient permissions');
    }

    next();
  };
};

/**
 * Permission-based authorization
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return unauthorized(res, 'Authentication required');
    }

    const userPermissions = ROLE_PERMISSIONS[req.user.role] || [];
    const hasPermission = userPermissions.includes(permission);

    if (!hasPermission) {
      logger.warn('Permission denied', {
        userId: req.user.id,
        userRole: req.user.role,
        requiredPermission: permission,
        endpoint: req.originalUrl
      });

      return forbidden(res, `Permission denied: ${permission}`);
    }

    next();
  };
};

/**
 * Resource ownership check
 */
const requireOwnership = (resourceIdParam = 'id', resourceModel = null) => {
  return async (req, res, next) => {
    if (!req.user) {
      return unauthorized(res, 'Authentication required');
    }

    const resourceId = req.params[resourceIdParam];

    // If resource model is provided, check ownership
    if (resourceModel && resourceId) {
      try {
        const resource = await resourceModel.findByPk(resourceId);

        if (!resource) {
          return res.status(404).json({
            success: false,
            message: 'Resource not found'
          });
        }

        // Check if user owns the resource or has admin permissions
        const isOwner = resource.userId === req.user.id;
        const isAdmin = ['ADMIN', 'SUPERADMIN'].includes(req.user.role);

        if (!isOwner && !isAdmin) {
          return forbidden(res, 'Access denied: resource ownership required');
        }
      } catch (err) {
        logger.error('Ownership check failed', { error: err.message });
        return error(res, 'Ownership verification failed', 500);
      }
    }

    next();
  };
};

/**
 * Rate limiting for sensitive operations
 */
const sensitiveOperationLimit = (maxRequests = 5, windowMs = 15 * 60 * 1000) => {
  const requests = new Map();

  return (req, res, next) => {
    const key = `${req.user.id}-${req.originalUrl}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old entries
    for (const [k, timestamps] of requests.entries()) {
      requests.set(k, timestamps.filter(timestamp => timestamp > windowStart));
      if (requests.get(k).length === 0) {
        requests.delete(k);
      }
    }

    // Check current requests
    const userRequests = requests.get(key) || [];
    if (userRequests.length >= maxRequests) {
      logger.warn('Rate limit exceeded for sensitive operation', {
        userId: req.user.id,
        endpoint: req.originalUrl
      });

      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }

    // Add current request
    userRequests.push(now);
    requests.set(key, userRequests);

    next();
  };
};

/**
 * Audit logging middleware
 */
const auditLog = (action, details = {}) => {
  return (req, res, next) => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      userId: req.user?.id || 'anonymous',
      userRole: req.user?.role || 'anonymous',
      action,
      endpoint: req.originalUrl,
      method: req.method,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      ...details
    };

    logger.info('Audit Log', logEntry);
    next();
  };
};

module.exports = {
  authenticate,
  optionalAuthenticate,
  authorize,
  requirePermission,
  requireOwnership,
  sensitiveOperationLimit,
  auditLog,
  generateAccessToken,
  generateRefreshToken,
  hashPassword,
  verifyPassword,
  generateOTP,
  hashOTP,
  verifyOTP,
  createLoginSession,
  invalidateLoginSession,
  ROLE_HIERARCHY,
  ROLE_PERMISSIONS
};