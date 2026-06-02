const crypto = require('crypto');
const { AppError } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_AUTH_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/login/verify-otp',
  '/api/auth/register',
  '/api/auth/verify-otp',
  '/api/auth/resend-otp',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/refresh',
]);

const csrfProtection = (req, res, next) => {
  let token = req.cookies?.csrfToken;
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    res.cookie('csrfToken', token, {
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
    });
  }
  if (
    SAFE_METHODS.has(req.method) ||
    PUBLIC_AUTH_PATHS.has(req.path) ||
    req.get('Authorization')
  ) return next();
  if (req.get('X-CSRF-Token') !== token) return next(new AppError('Request could not be verified', 403, 'AUTH_CSRF_INVALID'));
  return next();
};

module.exports = csrfProtection;
