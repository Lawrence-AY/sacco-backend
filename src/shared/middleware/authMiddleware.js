const bcrypt = require('bcrypt');
const jwtUtils = require('../utils/jwt');
const ResponseHandler = require('../utils/response');
const logger = require('../utils/logger');
const {
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  RateLimitError,
  AppError
} = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');

// 🔐 LOCAL OTP SYSTEM (configurable digit length)
const { generateOTP } = require('../utils/generateOTP');  // default 6-digit
const sendOTPEmail = require('../utils/sendOTPEmail');
const sessionService = require('../../services/sessionService');

// Models
const User = require('../../models/user.model');
const MembershipApplication = require('../../models/membershipApplication.model');
const db = require('../../models');

const OTP_REQUEST_WINDOW_MS = Number(process.env.OTP_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const OTP_REQUEST_MAX = Number(process.env.OTP_RATE_LIMIT_MAX || 1);
const LOGIN_LOCK_MAX_ATTEMPTS = Number(process.env.LOGIN_LOCK_MAX_ATTEMPTS || 5);
const LOGIN_LOCK_WINDOW_MS = Number(process.env.LOGIN_LOCK_WINDOW_MS || 15 * 60 * 1000);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const otpRequestBuckets = new Map();

const normalizeOtpKey = (purpose, email, req) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  return `${purpose}:${String(email || '').trim().toLowerCase()}:${ip}`;
};

const assertOtpRateLimit = (purpose, email, req) => {
  const now = Date.now();
  const key = normalizeOtpKey(purpose, email, req);
  const bucket = otpRequestBuckets.get(key) || { count: 0, resetAt: now + OTP_REQUEST_WINDOW_MS };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + OTP_REQUEST_WINDOW_MS;
  }

  bucket.count += 1;
  otpRequestBuckets.set(key, bucket);

  if (bucket.count > OTP_REQUEST_MAX) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw new RateLimitError(`Please wait ${retryAfter} seconds before requesting another OTP`);
  }
};

const serializeUser = (user) => {
  if (!user) return null;
  const source = typeof user.toJSON === 'function' ? user.toJSON() : { ...user };
  [
    'password',
    'otp',
    'otpExpiresAt',
    'passwordResetToken',
    'passwordResetExpires'
  ].forEach((field) => {
    delete source[field];
  });
  return source;
};

const getCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/',
});

const setAuthCookies = (res, tokens, sessionId) => {
  res.cookie('accessToken', tokens.accessToken, {
    ...getCookieOptions(),
    maxAge: 15 * 60 * 1000,
  });
  res.cookie('refreshToken', tokens.refreshToken, {
    ...getCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  if (sessionId) {
    res.cookie('sessionId', sessionId, {
      ...getCookieOptions(),
      httpOnly: false,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
};

const clearAuthCookies = (res) => {
  ['accessToken', 'refreshToken', 'sessionId'].forEach((name) => {
    res.clearCookie(name, getCookieOptions());
  });
};

const exposeTokensForEnvironment = (tokens) => {
  return tokens;
};

const createAuthTemporaryError = () => new AppError('Something went wrong', 503, 'SERVER_ERROR');

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
};

const createInvalidAuthError = () => new AppError('Invalid credentials or verification code', 401, 'AUTH_INVALID');
const createLockedError = () => new AppError('This account is temporarily locked. Please try again later.', 423, 'AUTH_LOCKED');
const createOtpInvalidError = () => new AppError('Invalid or expired verification code', 401, 'OTP_INVALID');
const createOtpExpiredError = () => new AppError('Invalid or expired verification code', 401, 'OTP_EXPIRED');

const isAccountLocked = (user) => user?.lockedUntil && new Date(user.lockedUntil) > new Date();

const recordFailedLogin = async (user) => {
  if (!user) return;
  const attempts = Number(user.failedLoginAttempts || 0) + 1;
  user.failedLoginAttempts = attempts;
  if (attempts >= LOGIN_LOCK_MAX_ATTEMPTS) {
    user.lockedUntil = new Date(Date.now() + LOGIN_LOCK_WINDOW_MS);
  }
  await user.save({ fields: ['failedLoginAttempts', 'lockedUntil'] });
};

const clearFailedLogin = async (user, req) => {
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastLoginIp = getClientIp(req);
  user.lastLoginAt = new Date();
  await user.save({ fields: ['failedLoginAttempts', 'lockedUntil', 'lastLoginIp', 'lastLoginAt'] });
};

const assignOtp = async (user, otp) => {
  user.otp = otp;
  user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  user.otpAttempts = 0;
  user.otpLastSentAt = new Date();
  await user.save({ fields: ['otp', 'otpExpiresAt', 'otpAttempts', 'otpLastSentAt'] });
};

const clearOtp = async (user) => {
  user.otp = null;
  user.otpExpiresAt = null;
  user.otpAttempts = 0;
  await user.save({ fields: ['otp', 'otpExpiresAt', 'otpAttempts'] });
};

const verifyStoredOtp = async (user, otp) => {
  if (!user?.otp || !user.otpExpiresAt || new Date(user.otpExpiresAt) < new Date()) {
    await clearOtp(user);
    throw createOtpExpiredError();
  }

  if (Number(user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
    await clearOtp(user);
    throw createOtpInvalidError();
  }

  if (String(user.otp) !== String(otp)) {
    user.otpAttempts = Number(user.otpAttempts || 0) + 1;
    await user.save({ fields: ['otpAttempts'] });
    if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
      await clearOtp(user);
    }
    throw createOtpInvalidError();
  }
};

const ensureMemberRecords = async (user, source = {}) => {
  let member = await db.Member.findOne({ where: { userId: user.id } });
  if (!member) {
    member = await db.Member.create({
      userId: user.id,
      memberNumber: `M-${Date.now()}`,
      type: source.type || 'NON_EMPLOYEE',
      nationalId: source.nationalId || user.nationalId || null,
      isVerified: true,
    });
  }

  const savings = await db.SavingsAccount.findOne({ where: { memberId: member.id } });
  if (!savings) {
    await db.SavingsAccount.create({ memberId: member.id });
  }

  const shares = await db.ShareAccount.findOne({ where: { memberId: member.id } });
  if (!shares) {
    await db.ShareAccount.create({ memberId: member.id });
  }

  return member;
};

/**
 * =========================
 * JWT TOKEN EXTRACTION
 * =========================
 */
const extractToken = (req) => {
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    return req.headers.authorization.substring(7);
  }
  return req.cookies?.accessToken || null;
};

/**
 * =========================
 * AUTH MIDDLEWARE
 * =========================
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    throw new UnauthorizedError('No token provided. Please authenticate.');
  }
  try {
    const decoded = jwtUtils.verifyToken(token);
    const user = await User.findByPk(decoded.id);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    req.user = user;
    req.sessionId = decoded.sessionId || req.headers['x-session-id'] || null;
    if (req.sessionId) {
      const session = await sessionService.touchSession(req.sessionId, user.id);
      if (!session) {
        throw new UnauthorizedError('This login session has expired or was revoked');
      }
    }
    next();
  } catch (error) {
    throw new UnauthorizedError(error.message || 'Token verification failed');
  }
});

const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      throw new UnauthorizedError('User not authenticated');
    }
    const userRole = String(req.user.role || '').toUpperCase();
    const normalizedAllowedRoles = allowedRoles.map((role) => String(role).toUpperCase());
    if (userRole === 'SUPERADMIN' || normalizedAllowedRoles.includes(userRole)) {
      return next();
    }
    {
      throw new ForbiddenError(
        `Access denied. Required roles: ${allowedRoles.join(', ')}`
      );
    }
  };
};

const admin = authorize(['ADMIN']);
const finance = authorize(['ADMIN', 'FINANCE']);
const member = authorize(['MEMBER', 'ADMIN']);

/**
 * =========================
 * PASSWORD HELPERS
 * =========================
 */
const hashPassword = async (password) => {
  if (!password || password.length < 6) {
    throw new ValidationError('Password must be at least 6 characters long');
  }
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

const verifyPassword = async (password, hashedPassword) => {
  return bcrypt.compare(password, hashedPassword);
};

/**
 * =========================
 * LOGIN
 * =========================
 */
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }
  assertOtpRateLimit('login', email, req);
  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw createInvalidAuthError();
  }
  if (isAccountLocked(user)) {
    throw createLockedError();
  }
  if (!user.isVerified) {
    throw createInvalidAuthError();
  }
  const isValid = await verifyPassword(password, user.password);
  if (!isValid) {
    await recordFailedLogin(user);
    throw createInvalidAuthError();
  }

  const otp = generateOTP();
  await assignOtp(user, otp);

  const loginSession = await sessionService.createOtpSession(user, req);

  try {
    await sendOTPEmail(user.email, otp);
  } catch (emailError) {
    logger.error({
      message: 'OTP send failed',
      module: 'auth',
      userId: user.id,
      email: user.email,
      error: emailError.message,
      stack: emailError.stack,
    });
    await clearOtp(user);
    throw createAuthTemporaryError();
  }

  return ResponseHandler.success(
    res,
    {
      requiresOtp: true,
      email: user.email,
      role: user.role,
      sessionId: loginSession.id,
      newDevice: loginSession.isNewDevice
    },
    'Login verification code sent',
    200
  );
});

const verifyLoginOTP = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    throw new ValidationError('Email and OTP required');
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw createOtpInvalidError();
  }
  if (isAccountLocked(user)) {
    throw createLockedError();
  }
  await verifyStoredOtp(user, otp);

  await clearOtp(user);
  await clearFailedLogin(user, req);
  const loginSession = await sessionService.activateSession(user, req);

  const tokens = jwtUtils.generateTokens(user.id, {
    role: user.role,
    sessionId: loginSession.id
  });
  setAuthCookies(res, tokens, loginSession.id);
  return ResponseHandler.success(
    res,
    {
      user: serializeUser(user),
      tokens: exposeTokensForEnvironment(tokens),
      sessionId: loginSession.id,
      newDevice: loginSession.isNewDevice
    },
    'Login successful'
  );
});

/**
 * =========================
 * REFRESH TOKEN
 * =========================
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  const token = refreshToken || req.cookies?.refreshToken;
  if (!token) {
    throw new UnauthorizedError('Refresh token is required');
  }
  try {
    const decoded = jwtUtils.verifyToken(token);
    if (decoded.type !== 'refresh') {
      throw new UnauthorizedError('Invalid token type');
    }
    const user = await User.findByPk(decoded.id);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    if (decoded.sessionId) {
      const session = await sessionService.assertActiveSession(decoded.sessionId, user.id);
      if (!session) {
        throw new UnauthorizedError('This login session has expired or was revoked');
      }
    }
    const newTokens = jwtUtils.generateTokens(user.id, {
      role: user.role,
      sessionId: decoded.sessionId
    });
    setAuthCookies(res, newTokens, decoded.sessionId);
    return ResponseHandler.success(res, exposeTokensForEnvironment(newTokens) || { refreshed: true }, 'Token refreshed', 200);
  } catch (error) {
    throw new UnauthorizedError('Failed to refresh token');
  }
});

/**
 * =========================
 * REGISTER + CONFIGURABLE OTP
 * =========================
 */
const registerUser = asyncHandler(async (req, res) => {
  const {
    firstName,
    lastName,
    name,
    email,
    phone,
    password,
    applicationId
  } = req.body || {};

  if (!firstName || !lastName || !email || !password) {
    throw new ValidationError('Missing required fields');
  }
  assertOtpRateLimit('register', email, req);

  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new ConflictError('Unable to complete registration with the provided details');
  }

  const application = applicationId
    ? await MembershipApplication.findByPk(applicationId)
    : await MembershipApplication.findOne({ where: { email } });

  if (application && application.status !== 'APPROVED') {
    throw new ValidationError('Application not approved yet');
  }

  const hashedPassword = await hashPassword(password);

  // 👇 Generate OTP – change digits by editing generateOTP() in utils
  const otp = generateOTP(); // default 6-digit, can be 8-digit (see note)

  const user = await User.create({
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    name: name || `${firstName} ${lastName}`,
    email: email.trim(),
    phone: phone || null,
    password: hashedPassword,
    role: 'PENDING',
    isVerified: false,
    otp,
    otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    otpAttempts: 0,
    otpLastSentAt: new Date()
  });

  try {
    await sendOTPEmail(email, otp);
  } catch (emailError) {
    logger.error({
      message: 'OTP send failed during registration',
      module: 'auth',
      userId: user.id,
      email: user.email,
      error: emailError.message,
      stack: emailError.stack,
    });
    await clearOtp(user);
    throw createAuthTemporaryError();
  }

  return ResponseHandler.created(
    res,
    { message: 'OTP sent to your email' },
    'Registration successful'
  );
});

/**
 * =========================
 * SET PASSWORD (from application activation)
 * =========================
 */
const setPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    throw new ValidationError('Token and new password are required');
  }

  const application = await MembershipApplication.findOne({
    where: {
      activationToken: token,
      status: 'APPROVED',
    }
  });
  if (!application) {
    throw new UnauthorizedError('Activation token is invalid or expired');
  }
  if (application.activationTokenExpiresAt && application.activationTokenExpiresAt < new Date()) {
    throw new UnauthorizedError('Activation token has expired');
  }

  const hashedPassword = await hashPassword(newPassword);
  const existingUser = await User.findOne({ where: { email: application.email } });
  const user = existingUser || await User.create({
    name: application.name,
    email: application.email,
    phone: application.phone,
    password: hashedPassword,
    nationalId: application.nationalId,
    kraPin: application.kraPin,
    occupation: application.occupation,
    address: application.address,
    role: 'MEMBER',
    isVerified: true
  });

  if (existingUser) {
    existingUser.password = hashedPassword;
    existingUser.role = 'MEMBER';
    existingUser.isVerified = true;
    existingUser.nationalId = existingUser.nationalId || application.nationalId;
    existingUser.kraPin = existingUser.kraPin || application.kraPin;
    existingUser.occupation = existingUser.occupation || application.occupation;
    existingUser.address = existingUser.address || application.address;
    await existingUser.save({
      fields: ['password', 'role', 'isVerified', 'nationalId', 'kraPin', 'occupation', 'address']
    });
  }

  await ensureMemberRecords(user, application);

  application.activationToken = null;
  application.activationTokenExpiresAt = null;
  await application.save();

  return ResponseHandler.success(
    res,
    {
      user: serializeUser({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role
      })
    },
    'Password set and account activated successfully',
    200
  );
});

/**
 * =========================
 * VERIFY OTP (LOCAL CONTROL)
 * =========================
 */
const verifyOTP = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};
  if (!email || !otp) {
    throw new ValidationError('Email and OTP required');
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw createOtpInvalidError();
  }
  await verifyStoredOtp(user, otp);

  user.isVerified = true;
  user.role = 'MEMBER';
  user.otp = null;
  user.otpExpiresAt = null;
  user.otpAttempts = 0;
  await user.save({ fields: ['isVerified', 'role', 'otp', 'otpExpiresAt', 'otpAttempts'] });
  await ensureMemberRecords(user);

  const tokens = jwtUtils.generateTokens(user.id, {
    role: user.role
  });
  setAuthCookies(res, tokens, null);

  return ResponseHandler.success(res, {
    user: serializeUser(user),
    tokens: exposeTokensForEnvironment(tokens)
  }, 'Email verified successfully');
});

/**
 * =========================
 * RESEND OTP
 * =========================
 */
const resendOTP = asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    throw new ValidationError('Email required');
  }
  assertOtpRateLimit('resend', email, req);

  const user = await User.findOne({ where: { email } });
  if (!user) {
    return ResponseHandler.success(res, { resendAvailableIn: 60 }, 'If eligible, a new verification code will be sent', 200);
  }

  if (user.isVerified) {
    const sessionId = req.headers['x-session-id'] || req.body?.sessionId || null;
    const pendingLogin = sessionId
      ? await db.LoginSession.findOne({ where: { id: sessionId, userId: user.id, status: 'OTP_SENT' } })
      : await db.LoginSession.findOne({
        where: { userId: user.id, status: 'OTP_SENT' },
        order: [['createdAt', 'DESC']]
      });
    if (!pendingLogin) {
      return ResponseHandler.success(res, { resendAvailableIn: 60 }, 'If eligible, a new verification code will be sent', 200);
    }
  }

  const otp = generateOTP(); // same digit length as register

  await assignOtp(user, otp);

  try {
    await sendOTPEmail(email, otp);
  } catch (emailError) {
    logger.error({
      message: 'OTP resend failed',
      module: 'auth',
      userId: user.id,
      email: user.email,
      error: emailError.message,
      stack: emailError.stack,
    });
    await clearOtp(user);
    throw createAuthTemporaryError();
  }

  return ResponseHandler.success(res, { resendAvailableIn: 60 }, 'OTP resent');
});

/**
 * =========================
 * LOGOUT
 * =========================
 */
const logoutUser = asyncHandler(async (req, res) => {
  const sessionId = req.body?.sessionId || req.sessionId || null;
  const userId = req.user?.id;
  if (sessionId && userId) {
    await sessionService.logoutSession(sessionId, userId);
  }
  clearAuthCookies(res);
  return ResponseHandler.success(res, null, 'Logged out');
});

const getSessions = asyncHandler(async (req, res) => {
  const sessions = await sessionService.listSessions(req.user.id, req.sessionId);
  return ResponseHandler.success(res, sessions, 'Sessions retrieved successfully', 200);
});

const revokeSession = asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!sessionId) {
    throw new ValidationError('Session ID is required');
  }
  if (sessionId === req.sessionId) {
    throw new ValidationError('Use logout to end the current session');
  }
  await sessionService.revokeSession(sessionId, req.user.id);
  const sessions = await sessionService.listSessions(req.user.id, req.sessionId);
  return ResponseHandler.success(res, sessions, 'Session revoked successfully', 200);
});

/**
 * =========================
 * EXPORTS
 * =========================
 */
module.exports = {
  protect,
  authorize,
  admin,
  finance,
  member,
  hashPassword,
  verifyPassword,
  extractToken,
  loginUser,
  verifyLoginOTP,
  refreshToken,
  registerUser,
  setPassword,
  verifyOTP,
  resendOTP,
  logoutUser,
  getSessions,
  revokeSession
};
