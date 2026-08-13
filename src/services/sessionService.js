const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const logger = require('../shared/utils/logger');
const { enqueueEmail, QUEUES } = require('./email/emailQueue');
const { buildNewDeviceEmail, getBrandLogoAttachments } = require('./email/templates');

const GEOLOCATION_TIMEOUT_MS = 2500;
const GEOLOCATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const geolocationCache = new Map();

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
  const latitude = getHeaderValue(req, 'x-vercel-ip-latitude') || getHeaderValue(req, 'x-geo-latitude') || getHeaderValue(req, 'x-latitude');
  const longitude = getHeaderValue(req, 'x-vercel-ip-longitude') || getHeaderValue(req, 'x-geo-longitude') || getHeaderValue(req, 'x-longitude');

  const parts = [city, region, country].filter(Boolean);
  const location = parts.length ? parts.join(', ') : 'Location unavailable';
  return latitude && longitude ? `${location} (${latitude}, ${longitude})` : location;
};

const isPublicIpAddress = (value) => {
  const ip = String(value || '').replace(/^::ffff:/, '').trim();
  if (!ip || ip === '::1' || ip === 'localhost') return false;
  if (ip.includes(':')) return !/^(?:fc|fd|fe80)/i.test(ip);
  const [first, second] = ip.split('.').map(Number);
  return !(first === 10 || first === 127 || first === 0 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
};

const lookupIpLocation = async (ipAddress) => {
  const ip = String(ipAddress || '').replace(/^::ffff:/, '').trim();
  if (!isPublicIpAddress(ip)) return 'Location unavailable';

  const cached = geolocationCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.location;

  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(GEOLOCATION_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    const payload = response.ok ? await response.json() : null;
    const location = payload?.success
      ? [payload.city, payload.region, payload.country].filter(Boolean).join(', ')
      : '';
    if (location) {
      geolocationCache.set(ip, { location, expiresAt: Date.now() + GEOLOCATION_CACHE_TTL_MS });
      return location;
    }
  } catch (error) {
    logger.warn('IP geolocation lookup failed', { module: 'auth', error: error.message });
  }
  return 'Location unavailable';
};

const resolveSessionLocation = async (session) => {
  const existing = String(session?.location || '');
  const parts = existing.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) return existing;

  const geolocated = await lookupIpLocation(session?.ipAddress);
  const location = geolocated !== 'Location unavailable'
    ? geolocated
    : (existing || 'Location unavailable');
  if (location !== session?.location && typeof session?.update === 'function') {
    await session.update({ location });
  }
  return location;
};

const getDeviceInfo = (req) => {
  const userAgent = req.headers['user-agent'] || 'Unknown browser';
  const clientBrand = getHeaderValue(req, 'sec-ch-ua');
  const clientPlatform = getHeaderValue(req, 'sec-ch-ua-platform').replace(/^"|"$/g, '');
  const clientMobile = getHeaderValue(req, 'sec-ch-ua-mobile');
  const providedDeviceName = getHeaderValue(req, 'x-device-name');
  const deviceName = providedDeviceName
    || [clientBrand, clientPlatform, clientMobile ? `mobile=${clientMobile}` : ''].filter(Boolean).join(' | ')
    || userAgent;
  return {
    deviceId: getHeaderValue(req, 'x-device-id') || `${userAgent}:${clientPlatform || 'unknown-platform'}`,
    deviceName,
    userAgent,
    ipAddress: getClientIp(req),
    location: getLoginLocation(req)
  };
};

const notifyNewDevice = async (user, session) => {
  const location = await resolveSessionLocation(session);
  const sessionData = typeof session.get === 'function' ? session.get({ plain: true }) : session;
  const emailSession = { ...sessionData, location };
  await enqueueEmail(QUEUES.NOTIFICATIONS, 'NOTIFICATION', {
    to: user.email,
    subject: 'New device login on your AYEDOS SACCO account',
    html: buildNewDeviceEmail({
      recipientName: user.firstName || user.name || 'Member',
      session: emailSession,
    }),
    attachments: getBrandLogoAttachments(),
  });
};

const createOtpSession = async (user, req, idempotencyKey = null) => {
  const device = getDeviceInfo(req);
  if (idempotencyKey) {
    const idempotentSession = await db.LoginSession.findOne({ where: { idempotencyKey, userId: user.id } });
    const isReusable = idempotentSession
      && idempotentSession.status === 'OTP_SENT'
      && Date.now() - new Date(idempotentSession.createdAt).getTime() < 10 * 60_000;
    if (isReusable) {
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
      if (session?.status === 'OTP_SENT') {
        logger.info('Login session recovered after idempotency race', { module: 'auth', userId: user.id, loginSessionId: session.id });
        return session;
      }
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

  return Promise.all(sessions.map(async (session) => {
    const location = await resolveSessionLocation(session);
    return {
    id: session.id,
    device: session.deviceName || 'Unknown device',
    deviceName: session.deviceName || 'Unknown device',
    ip: session.ipAddress || '-',
    location,
    status: session.status,
    event: session.event || 'Login',
    date: session.loginAt || session.createdAt,
    lastActive: session.lastActiveAt || session.updatedAt,
    current: session.id === currentSessionId,
    isNewDevice: session.isNewDevice
    };
  }));
};

module.exports = {
  getDeviceInfo,
  lookupIpLocation,
  resolveSessionLocation,
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
