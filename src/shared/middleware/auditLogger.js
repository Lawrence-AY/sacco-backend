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

    const action = inferAction(req);
    const moduleName = inferModule(req);
    const event = {
      actorId: req.user?.id || null,
      userId: req.user?.id || null,
      action,
      module: moduleName,
      actorRole: req.user?.role || null,
      actorName: req.user?.name || [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || null,
      method: req.method,
      route: req.originalUrl,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      body: redact(req.body),
      params: redact(req.params),
      query: redact(req.query),
      timestamp: new Date().toISOString(),
    };

    logger.info('Audit event', event);

    try {
      const db = require('../../models');
      if (db.AuditLog) {
        db.AuditLog.create({
          userId: event.userId,
          action: event.action,
          module: event.module,
          method: event.method,
          route: event.route,
          statusCode: event.statusCode,
          ip: event.ip,
          userAgent: event.userAgent,
          metadata: {
            actorRole: event.actorRole,
            actorName: event.actorName,
            sessionRef: req.user?.sessionId ? `session:${String(req.user.sessionId).slice(-8)}` : 'Not recorded',
            portal: req.get('X-Access-Portal') || (req.originalUrl.startsWith('/api/') ? 'Admin Portal / API' : 'System Job'),
            device: req.get('User-Agent') || 'Unknown device',
            status: res.statusCode === 202 ? 'PENDING_APPROVAL' : res.statusCode >= 400 ? 'FAILED' : 'SUCCESS',
            severity: res.statusCode >= 500 ? 'CRITICAL' : res.statusCode >= 400 ? 'WARN' : 'INFO',
            durationMs: event.durationMs,
            body: event.body,
            params: event.params,
            query: event.query,
          },
        }).catch((error) => {
          logger.error('Failed to persist audit event', { error: error.message, stack: error.stack });
        });
      }
    } catch (error) {
      logger.error('Audit persistence unavailable', { error: error.message });
    }
  });

  next();
};

const inferModule = (req) => {
  const [, , moduleName] = String(req.originalUrl || '').split('/');
  return moduleName || 'system';
};

const inferAction = (req) => {
  const url = String(req.originalUrl || '').toLowerCase();
  if (url.includes('/auth/login')) return 'LOGIN_ATTEMPT';
  if (url.includes('password') || url.includes('reset')) return 'PASSWORD_RESET';
  if (url.includes('/profile')) return 'PROFILE_UPDATE';
  if (url.includes('/loans') && url.includes('approve')) return 'LOAN_APPROVAL';
  if (url.includes('/applications') && url.includes('approve')) return 'MEMBER_APPROVAL';
  if (url.includes('/transactions') || url.includes('/finance')) return 'FINANCIAL_TRANSACTION';
  return `${req.method}_${inferModule(req).toUpperCase()}`;
};

module.exports = auditLogger;
