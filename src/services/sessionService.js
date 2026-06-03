const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const logger = require('../shared/utils/logger');
const { enqueueEmail, QUEUES } = require('./email/emailQueue');

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
};

const getHeaderValue = (req, headerName) => {
  const value = req.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ? String(value) : '';
};

const decodeHeaderLocation = (value) => {
  if (!value) return '';
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch {
    return String(value);
  }
};

const getLoginLocation = (req) => {
  const city = decodeHeaderLocation(getHeaderValue(req, 'x-vercel-ip-city')) || decodeHeaderLocation(getHeaderValue(req, 'x-geo-city'));
  const region = decodeHeaderLocation(getHeaderValue(req, 'x-vercel-ip-country-region')) || decodeHeaderLocation(getHeaderValue(req, 'x-region')) || decodeHeaderLocation(getHeaderValue(req, 'x-country-region'));
  const country =
    decodeHeaderLocation(getHeaderValue(req, 'x-vercel-ip-country')) ||
    decodeHeaderLocation(getHeaderValue(req, 'cf-ipcountry')) ||
    decodeHeaderLocation(getHeaderValue(req, 'cloudfront-viewer-country')) ||
    decodeHeaderLocation(getHeaderValue(req, 'x-akamai-country-code')) ||
    decodeHeaderLocation(getHeaderValue(req, 'x-country-code')) ||
    decodeHeaderLocation(getHeaderValue(req, 'x-geo-country'));

  const parts = [city, region, country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Location unavailable';
};

const getDeviceInfo = (req) => {
  const userAgent = req.headers['user-agent'] || 'Unknown browser';
  return {
    deviceId: req.headers['x-device-id'] || userAgent,
    deviceName: req.headers['x-device-name'] || userAgent,
    userAgent,
    ipAddress: getClientIp(req),
    location: getLoginLocation(req)
  };
};

const notifyNewDevice = async (user, session) => {
  await enqueueEmail(QUEUES.NOTIFICATIONS, 'NOTIFICATION', {
    to: user.email,
    subject: 'New device login on your AYEDOS account',
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2>New device login detected</h2>
        <p>Hello ${user.firstName || user.name || 'Member'},</p>
        <p>Your AYEDOS account was accessed using a device we have not seen before.</p>
        <ul>
          <li><strong>Device:</strong> ${session.deviceName || 'Unknown device'}</li>
          <li><strong>IP:</strong> ${session.ipAddress || 'Unknown IP'}</li>
          <li><strong>Time:</strong> ${new Date(session.loginAt || Date.now()).toLocaleString()}</li>
        </ul>
        <p>If this was not you, change your password immediately.</p>
      </div>
    `
  });
};

const createOtpSession = async (user, req, idempotencyKey = null) => {
  const device = getDeviceInfo(req);
  if (idempotencyKey) {
    const idempotentSession = await db.LoginSession.findOne({ where: { idempotencyKey, userId: user.id } });
    if (idempotentSession) {
      logger.info('Login session reused by idempotency key', { module: 'auth', userId: user.id, loginSessionId: idempotentSession.id });
      return idempotentSession;
    }
  }
  const existing = await db.LoginSession.findOne({
    where: { userId: user.id, deviceId: device.deviceId, status: 'OTP_SENT' },
    order: [['createdAt', 'DESC']],
  });
  if (existing && Date.now() - new Date(existing.createdAt).getTime() < 10 * 60_000) {
    logger.info('Existing pending login session reused', { module: 'auth', userId: user.id, loginSessionId: existing.id });
    return existing;
  }
  const knownDevice = await db.LoginSession.findOne({
    where: {
      userId: user.id,
      deviceId: device.deviceId,
      status: { [Op.in]: ['ACTIVE', 'LOGGED_OUT'] }
    }
  });

  try {
    const session = await db.LoginSession.create({
      userId: user.id,
      ...device,
      status: 'OTP_SENT',
      isNewDevice: !knownDevice,
      event: 'Login OTP sent',
      lastActiveAt: new Date(),
      idempotencyKey,
    });
    logger.info('Login session created', { module: 'auth', userId: user.id, loginSessionId: session.id, isNewDevice: session.isNewDevice });
    return session;
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError' && idempotencyKey) {
      const session = await db.LoginSession.findOne({ where: { idempotencyKey, userId: user.id } });
      logger.info('Login session recovered after idempotency race', { module: 'auth', userId: user.id, loginSessionId: session?.id });
      return session;
    }
    throw error;
  }
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const setRefreshToken = async (sessionId, refreshToken) => {
  if (!sessionId || !refreshToken) return null;
  const session = await db.LoginSession.findByPk(sessionId);
  if (!session) return null;
  await session.update({ refreshTokenHash: hashToken(refreshToken) });
  return session;
};

const matchesRefreshToken = (session, refreshToken) => Boolean(
  session?.refreshTokenHash &&
  refreshToken &&
  crypto.timingSafeEqual(Buffer.from(session.refreshTokenHash, 'hex'), Buffer.from(hashToken(refreshToken), 'hex'))
);

const activateSession = async (user, req) => {
  const device = getDeviceInfo(req);
  const session = await db.LoginSession.findOne({
    where: {
      userId: user.id,
      deviceId: device.deviceId,
      status: 'OTP_SENT'
    },
    order: [['createdAt', 'DESC']]
  });

  const record = session || await createOtpSession(user, req);
  await db.LoginSession.update(
    {
      status: 'LOGGED_OUT',
      event: 'Revoked by new device sign-in',
      logoutAt: new Date(),
      lastActiveAt: new Date()
    },
    {
      where: {
        userId: user.id,
        id: { [Op.ne]: record.id },
        status: 'ACTIVE'
      }
    }
  );

  await record.update({
    ...device,
    status: 'ACTIVE',
    event: 'Login successful',
    loginAt: new Date(),
    lastActiveAt: new Date()
  });

  if (record.isNewDevice) {
    notifyNewDevice(user, record).catch((error) => {
      logger.error('New device email failed', { module: 'auth', userId: user.id, error: error.message });
    });
  }

  return record;
};

const touchSession = async (sessionId, userId) => {
  if (!sessionId) return null;
  const session = await db.LoginSession.findOne({ where: { id: sessionId, userId } });
  if (!session || session.status !== 'ACTIVE') return null;
  await session.update({ lastActiveAt: new Date() });
  return session;
};

const assertActiveSession = async (sessionId, userId) => {
  if (!sessionId) return null;
  const session = await db.LoginSession.findOne({ where: { id: sessionId, userId } });
  if (!session || session.status !== 'ACTIVE') {
    logger.warn('Login session expired or inactive', { module: 'auth', userId, sessionId });
    return null;
  }
  return session;
};

const logoutSession = async (sessionId, userId) => {
  if (!sessionId) return null;
  const session = await db.LoginSession.findOne({ where: { id: sessionId, userId } });
  if (!session) return null;
  await session.update({ status: 'LOGGED_OUT', event: 'Logout', logoutAt: new Date(), lastActiveAt: new Date() });
  return session;
};

const revokeSession = async (sessionId, userId) => {
  if (!sessionId) return null;
  const session = await db.LoginSession.findOne({ where: { id: sessionId, userId } });
  if (!session || session.status !== 'ACTIVE') return session;
  await session.update({
    status: 'LOGGED_OUT',
    event: 'Revoked by account owner',
    logoutAt: new Date(),
    lastActiveAt: new Date()
  });
  return session;
};

const listSessions = async (userId, currentSessionId) => {
  const sessions = await db.LoginSession.findAll({
    where: { userId },
    order: [['createdAt', 'DESC']],
    limit: 50
  });

  return sessions.map((session) => ({
    id: session.id,
    device: session.deviceName || 'Unknown device',
    deviceName: session.deviceName || 'Unknown device',
    ip: session.ipAddress || '-',
    location: session.location || 'Unknown location',
    status: session.status,
    event: session.event || 'Login',
    date: session.loginAt || session.createdAt,
    lastActive: session.lastActiveAt || session.updatedAt,
    current: session.id === currentSessionId,
    isNewDevice: session.isNewDevice
  }));
};

module.exports = {
  getDeviceInfo,
  createOtpSession,
  activateSession,
  assertActiveSession,
  touchSession,
  logoutSession,
  revokeSession,
  listSessions,
  setRefreshToken,
  matchesRefreshToken
};
