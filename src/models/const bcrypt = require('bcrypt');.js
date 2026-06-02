const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const jwtUtils = require('../utils/jwt');
const ResponseHandler = require('../utils/response');
const {
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError
} = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');

// ✅ FIXED IMPORT
const { sendOTP } = require('../../../services/emailService');

// Models
const User = require('../../models/user.model');
const MembershipApplication = require('../../models/membershipApplication.model');

// ✅ Supabase client (REQUIRED for verifyOtp)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Extract token
 */
const extractToken = (req) => {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.substring(7);
  }
  return null;
};

/**
 * Protect middleware
 */
const protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw new UnauthorizedError('No token provided');

  const decoded = jwtUtils.verifyToken(token);
  const user = await User.findByPk(decoded.id);

  if (!user) throw new UnauthorizedError('User not found');

  req.user = user;
  next();
});

/**
 * Role middleware
 */
const authorize = (roles = []) => (req, res, next) => {
  if (!req.user) throw new UnauthorizedError('User not authenticated');

  if (!roles.includes(req.user.role)) {
    throw new ForbiddenError(`Access denied`);
  }

  next();
};

const admin = authorize(['ADMIN']);
const finance = authorize(['ADMIN', 'FINANCE']);
const member = authorize(['MEMBER', 'ADMIN']);

/**
 * Password helpers
 */
const hashPassword = async (password) => {
  if (!password || password.length < 6) {
    throw new ValidationError('Password must be at least 6 characters long');
  }
  return await bcrypt.hash(password, 10);
};

const verifyPassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

/**
 * REGISTER → SEND OTP
 */
const registerUser = asyncHandler(async (req, res) => {
  const { name, email, phone, applicationId } = req.body || {};

  if (!email) {
    throw new ValidationError('Email is required');
  }

  // Optional: validate application
  const application = await MembershipApplication.findOne({ where: { email } });
  if (application && application.status !== 'APPROVED') {
    throw new ValidationError('Application not approved yet');
  }

  // ✅ Use service (NOT direct supabase call)
  await sendOTP(email, {
    name,
    phone,
    application_id: applicationId
  });

  return ResponseHandler.success(res, null, 'OTP sent to your email');
});

/**
 * VERIFY OTP
 */
const verifyOTP = asyncHandler(async (req, res) => {
  const { email, token } = req.body;

  if (!email || !token) {
    throw new ValidationError('Email and OTP are required');
  }

  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email'
  });

  if (error) throw new UnauthorizedError(error.message);

  // ✅ Sync DB user
  let user = await User.findOne({ where: { email } });

  if (!user) {
    user = await User.create({
      email,
      role: 'MEMBER',
      isVerified: true
    });
  } else {
    user.isVerified = true;
    await user.save();
  }

  // ✅ Issue JWT
  const tokens = jwtUtils.generateTokens(user.id, {
    email: user.email,
    role: user.role
  });

  return ResponseHandler.success(res, {
    user,
    tokens
  }, 'Email verified successfully');
});

/**
 * LOGIN
 */
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  const user = await User.findOne({ where: { email } });

  if (!user) throw new UnauthorizedError('Invalid credentials');
  if (!user.isVerified) throw new UnauthorizedError('Email not verified');
  if (!user.password) throw new UnauthorizedError('Set password first');

  const isValid = await verifyPassword(password, user.password);
  if (!isValid) throw new UnauthorizedError('Invalid credentials');

  const tokens = jwtUtils.generateTokens(user.id, {
    email: user.email,
    role: user.role
  });

  return ResponseHandler.success(res, { user, tokens }, 'Login successful');
});

/**
 * SET PASSWORD
 */
const setPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body || {};

  if (!token || !newPassword) {
    throw new ValidationError('Token and password are required');
  }

  const application = await MembershipApplication.findOne({
    where: {
      activationToken: token,
      status: 'APPROVED'
    }
  });

  if (!application) {
    throw new UnauthorizedError('Invalid or expired token');
  }

  const existingUser = await User.findOne({ where: { email: application.email } });
  if (existingUser) {
    throw new ConflictError('User already exists');
  }

  const hashed = await hashPassword(newPassword);

  const user = await User.create({
    name: application.name,
    email: application.email,
    phone: application.phone,
    password: hashed,
    role: 'MEMBER',
    isVerified: true
  });

  application.activationToken = null;
  application.activationTokenExpiresAt = null;
  await application.save();

  return ResponseHandler.success(res, { user }, 'Account activated');
});

/**
 * REFRESH TOKEN
 */
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken) throw new UnauthorizedError('Refresh token required');

  const decoded = jwtUtils.verifyToken(refreshToken);
  const user = await User.findByPk(decoded.id);

  if (!user) throw new UnauthorizedError('User not found');

  const tokens = jwtUtils.generateTokens(user.id);

  return ResponseHandler.success(res, tokens, 'Token refreshed');
});

/**
 * LOGOUT
 */
const logoutUser = asyncHandler(async (req, res) => {
  return ResponseHandler.success(res, null, 'Logged out successfully');
});

module.exports = {
  protect,
  authorize,
  admin,
  finance,
  member,
  loginUser,
  registerUser,
  verifyOTP,
  setPassword,
  refreshToken,
  logoutUser
};