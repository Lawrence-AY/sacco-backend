const bcrypt = require('bcrypt');
const jwtUtils = require('../utils/jwt');
const ResponseHandler = require('../utils/response');
const {
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError
} = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');

// 🔐 LOCAL OTP SYSTEM (configurable digit length)
const { generateOTP } = require('../utils/generateOTP');  // default 6-digit
const { sendOTPEmail } = require('../utils/sendOTPEmail');
const sessionService = require('../../services/sessionService');

// Models
const User = require('../../models/user.model');
const MembershipApplication = require('../../models/membershipApplication.model');
const db = require('../../models');

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
  return null;
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
    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(
        `Access denied. Required roles: ${allowedRoles.join(', ')}`
      );
    }
    next();
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
  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }
  if (!user.isVerified) {
    throw new UnauthorizedError('Please verify your email first');
  }
  const isValid = await verifyPassword(password, user.password);
  if (!isValid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const otp = generateOTP();
  user.otp = otp;
  user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save({ fields: ['otp', 'otpExpiresAt'] });
  const loginSession = await sessionService.createOtpSession(user, req);
  await sendOTPEmail(user.email, otp);

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
    throw new UnauthorizedError('User not found');
  }
  if (String(user.otp) !== String(otp)) {
    throw new UnauthorizedError('Invalid OTP');
  }
  if (new Date(user.otpExpiresAt) < new Date()) {
    throw new UnauthorizedError('OTP expired');
  }

  user.otp = null;
  user.otpExpiresAt = null;
  await user.save({ fields: ['otp', 'otpExpiresAt'] });
  const loginSession = await sessionService.activateSession(user, req);

  const tokens = jwtUtils.generateTokens(user.id, {
    role: user.role,
    sessionId: loginSession.id
  });
  return ResponseHandler.success(
    res,
    { user: serializeUser(user), tokens, sessionId: loginSession.id, newDevice: loginSession.isNewDevice },
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
  if (!refreshToken) {
    throw new UnauthorizedError('Refresh token is required');
  }
  try {
    const decoded = jwtUtils.verifyToken(refreshToken);
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
    return ResponseHandler.success(res, newTokens, 'Token refreshed', 200);
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

  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new ConflictError('User already exists');
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
    otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 min
  });

  // Send email with OTP
  await sendOTPEmail(email, otp);

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
    throw new UnauthorizedError('User not found');
  }
 if (String(user.otp) !== String(otp)) {
    throw new UnauthorizedError('Invalid OTP');
  }
  if (new Date(user.otpExpiresAt) < new Date()) {
    throw new UnauthorizedError('OTP expired');
  }

  user.isVerified = true;
  user.role = 'MEMBER';
  user.otp = null;
  user.otpExpiresAt = null;
  await user.save();
  await ensureMemberRecords(user);

  const tokens = jwtUtils.generateTokens(user.id, {
    role: user.role
  });

  return ResponseHandler.success(res, { user: serializeUser(user), tokens }, 'Email verified successfully');
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

  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw new UnauthorizedError('User not found');
  }
  if (user.isVerified) {
    throw new ValidationError('Already verified');
  }

  const otp = generateOTP(); // same digit length as register

  user.otp = otp;
  user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  await sendOTPEmail(email, otp);

  return ResponseHandler.success(res, { message: 'OTP resent successfully' }, 'OTP resent');
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
