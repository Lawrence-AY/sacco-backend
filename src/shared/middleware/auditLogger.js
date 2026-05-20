const logger = require('../utils/logger');

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
];

const redact = (value) => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);

  return Object.entries(value).reduce((safe, [key, item]) => {
    const lower = key.toLowerCase();
    safe[key] = SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive.toLowerCase()))
      ? '[REDACTED]'
      : redact(item);
    return safe;
  }, {});
};

const auditLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const isAuditable =
      req.originalUrl.startsWith('/api/auth') ||
      req.originalUrl.startsWith('/api/admin') ||
      req.originalUrl.startsWith('/api/finance') ||
      req.originalUrl.startsWith('/api/transactions') ||
      req.originalUrl.startsWith('/api/loans') ||
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);

    if (!isAuditable) return;

    logger.info('Audit event', {
      actorId: req.user?.id || null,
      actorRole: req.user?.role || null,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      body: redact(req.body),
      params: redact(req.params),
      query: redact(req.query),
      timestamp: new Date().toISOString(),
    });
  });

  next();
};

module.exports = auditLogger;
