const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const { AppError, RateLimitError } = require('../shared/utils/errors');

const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 10 * 60_000);
const OTP_RESEND_COOLDOWN_MS = Number(process.env.OTP_RESEND_COOLDOWN_MS || 60_000);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);

const hashOtp = (otp) => crypto
  .createHmac('sha256', process.env.OTP_HASH_SECRET || process.env.JWT_SECRET || 'development-only-otp-key')
  .update(String(otp))
  .digest('hex');

const createOtpSession = async ({ userId, loginSessionId = null, purpose, otp }) => {
  await db.OtpSession.update({ consumed: true }, { where: { userId, purpose, consumed: false } });
  return db.OtpSession.create({
    userId,
    loginSessionId,
    purpose,
    otpHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
    attempts: 0,
    consumed: false,
    lastSentAt: new Date(),
  });
};

const getActiveOtpSession = ({ userId, loginSessionId = null, purpose }) => db.OtpSession.findOne({
  where: {
    userId,
    purpose,
    consumed: false,
    expiresAt: { [Op.gt]: new Date() },
    ...(loginSessionId ? { loginSessionId } : {}),
  },
  order: [['createdAt', 'DESC']],
});

const assertResendAllowed = (session) => {
  if (!session?.lastSentAt) return;
  const nextAllowedAt = new Date(session.lastSentAt).getTime() + OTP_RESEND_COOLDOWN_MS;
  if (nextAllowedAt > Date.now()) throw new RateLimitError(`Please wait ${Math.ceil((nextAllowedAt - Date.now()) / 1000)} seconds before requesting another OTP`);
};

const verifyOtp = async ({ userId, loginSessionId = null, purpose, otp }) => {
  const session = await getActiveOtpSession({ userId, loginSessionId, purpose });
  if (!session) throw new AppError('Invalid or expired verification code', 401, 'AUTH_OTP_EXPIRED');
  if (session.attempts >= OTP_MAX_ATTEMPTS) throw new AppError('Invalid or expired verification code', 401, 'AUTH_OTP_INVALID');
  const actual = Buffer.from(hashOtp(otp), 'hex');
  const expected = Buffer.from(session.otpHash, 'hex');
  if (!crypto.timingSafeEqual(actual, expected)) {
    await session.increment('attempts');
    throw new AppError('Invalid or expired verification code', 401, 'AUTH_OTP_INVALID');
  }
  await session.update({ consumed: true });
  return session;
};

module.exports = { createOtpSession, getActiveOtpSession, assertResendAllowed, verifyOtp };
