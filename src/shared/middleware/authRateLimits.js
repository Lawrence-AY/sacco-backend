const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const { RedisStore } = require('rate-limit-redis');
const logger = require('../utils/logger');

const fingerprint = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
const keyGenerator = (req) => `${fingerprint(req.ip)}:${fingerprint(req.body?.email?.trim()?.toLowerCase())}`;
const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false }) : null;
const isLocalDevelopmentOrigin = (req) => {
  if (process.env.NODE_ENV === 'production') return false;
  const origin = req.get('origin') || '';
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
};

const createLimiter = ({ name, windowMs, max }) => rateLimit({
  windowMs,
  max,
  ...(redis ? {
    store: new RedisStore({
      prefix: `rate-limit:${name}:`,
      sendCommand: (...args) => redis.call(...args),
    }),
  } : {}),
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isLocalDevelopmentOrigin,
  handler: (req, res) => {
    logger.warn('Authentication rate limit hit', {
      module: 'auth',
      rateLimit: name,
      requestId: req.id,
      ip: req.ip,
      endpoint: req.originalUrl,
      emailFingerprint: fingerprint(req.body?.email),
    });
    res.status(429).json({
      success: false,
      errorCode: 'AUTH_RATE_LIMITED',
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many requests. Please wait before trying again.',
      requestId: req.id,
    });
  },
});

module.exports = {
  loginLimiter: createLimiter({ name: 'login', windowMs: 15 * 60_000, max: 10 }),
  otpVerificationLimiter: createLimiter({ name: 'otp-verification', windowMs: 10 * 60_000, max: 10 }),
  otpResendLimiter: createLimiter({ name: 'otp-resend', windowMs: 60_000, max: 3 }),
  passwordResetLimiter: createLimiter({ name: 'password-reset', windowMs: 60 * 60_000, max: 3 }),
};
