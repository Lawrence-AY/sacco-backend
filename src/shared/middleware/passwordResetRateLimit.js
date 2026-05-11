const ResponseHandler = require('../utils/response');
const { createLogFingerprint, normalizeEmail } = require('../utils/passwordReset');

const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS = 3;
const requestStore = new Map();

const forgotPasswordRateLimiter = (req, res, next) => {
  const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
  const key = email || 'missing-email';
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const attempts = (requestStore.get(key) || []).filter((timestamp) => timestamp > windowStart);

  if (attempts.length >= MAX_REQUESTS) {
    console.warn('[AUTH] Forgot password rate limit exceeded', {
      emailFingerprint: createLogFingerprint(email)
    });

    return ResponseHandler.error(
      res,
      'Too many password reset requests. Please try again in an hour.',
      429
    );
  }

  attempts.push(now);
  requestStore.set(key, attempts);
  return next();
};

module.exports = {
  forgotPasswordRateLimiter
};
