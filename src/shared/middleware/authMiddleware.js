const bcrypt = require('bcrypt');
const jwtUtils = require('../utils/jwt');
const ResponseHandler = require('../utils/response');
const { UnauthorizedError, ForbiddenError, ValidationError, ConflictError } = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');
const { sendOTP } = require('../utils/sendOTP');

// Import models
const User = require('../../models/user.model');
const MembershipApplication = require('../../models/membershipApplication.model');

/**
 * Protect routes - verify JWT token
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
    next();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    throw new UnauthorizedError(error.message || 'Token verification failed');
  }
});

/**
 * Extract token from request header
 */
const extractToken = (req) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.substring(7);
  }
  return null;
};

/**
 * Role-based access control middleware factory
 */
const authorize = (allowedRoles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      throw new UnauthorizedError('User not authenticated');
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(
        `Access denied. Required roles: ${allowedRoles.join(', ')}. Your role: ${req.user.role}`
      );
    }

    next();
  };
};

/**
 * Admin middleware - check if user is admin
 */
const admin = authorize(['ADMIN']);

/**
 * Finance middleware - check if user is finance or admin
 */
const finance = authorize(['ADMIN', 'FINANCE']);

/**
 * Member middleware - check if user is member
 */
const member = authorize(['MEMBER', 'ADMIN']);

/**
 * Generate 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Hash password using bcrypt
 */
const hashPassword = async (password) => {
  if (!password || password.length < 6) {
    throw new ValidationError('Password must be at least 6 characters long');
  }
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

/**
 * Verify password
 */
const verifyPassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

/**
 * Login user & get tokens
 * @route   POST /api/auth/login
 * @access  Public
 */
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  // Validate input
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  // Find user by email
  const user = await User.findOne({ where: { email } });

  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
  }

  if (!user.isVerified) {
    throw new UnauthorizedError('Please verify your email address before logging in.');
  }
  if (!user.password) {
    throw new UnauthorizedError('Your account has not been activated yet. Please contact the SACCO team for assistance.');
  }

  // Compare passwords
  const isPasswordValid = await verifyPassword(password, user.password);

  if (!isPasswordValid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // Generate tokens
  const tokens = jwtUtils.generateTokens(user.id, {
    email: user.email,
    role: user.role
  });

  // Return success response
  return ResponseHandler.success(res, {
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      consentGiven: user.consentGiven
    },
    tokens,
  }, 'Login successful', 200);
});

/**
 * Refresh access token
 * @route   POST /api/auth/refresh
 * @access  Public
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

    const newTokens = jwtUtils.generateTokens(user.id, {
      email: user.email,
      role: user.role
    });

    return ResponseHandler.success(res, newTokens, 'Token refreshed successfully', 200);
  } catch (error) {
    throw new UnauthorizedError('Failed to refresh token: ' + error.message);
  }
});

/**
 * Logout user (client-side token deletion)
 * Note: Since we use stateless JWT, logout is primarily a client-side operation
 */
const logoutUser = asyncHandler(async (req, res) => {
  // Client should delete the token
  return ResponseHandler.success(res, null, 'Logged out successfully', 200);
});

/**
 * Register new user
 * @route   POST /api/auth/register
 * @access  Public
 */
const registerUser = asyncHandler(async (req, res) => {
  const { firstName, lastName, name, email, phone, password, role = 'MEMBER', applicationId } = req.body || {};

  // Validate input
  if (!firstName || !lastName || !email || !password) {
    throw new ValidationError('First name, last name, email and password are required');
  }

  const fullName = name?.trim() || [firstName, lastName].filter(Boolean).join(' ').trim();

  const application = applicationId
    ? await MembershipApplication.findByPk(applicationId)
    : await MembershipApplication.findOne({ where: { email } });

  if (applicationId) {
    if (!application) {
      throw new ValidationError('Associated application not found');
    }

    if (application.email !== email) {
      throw new ValidationError('Email does not match approved application');
    }

    if (application.status !== 'APPROVED') {
      throw new ValidationError('Your application must be approved before registration');
    }
  } else if (application) {
    if (application.status !== 'APPROVED') {
      throw new ValidationError('Your membership application must be approved before you can register');
    }
  }

  // Check if user already exists
  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new ValidationError('User with this email already exists', { email: 'Email already in use' });
  }

  const hashedPassword = await hashPassword(password);

  // Generate OTP
  const otp = generateOTP();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  // Create pending user with hashed password
  const user = await User.create({
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    name: fullName,
    email: email.trim(),
    phone: phone ? phone.trim() : null,
    password: hashedPassword,
    role: 'PENDING',
    otp,
    otpExpiresAt,
    isVerified: false
  });

  // Send OTP email
  await sendOTP(email, otp);

  return ResponseHandler.created(res, {
    message: 'OTP sent to your email'
  }, 'OTP sent to email');
});

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

  const existingUser = await User.findOne({ where: { email: application.email } });
  if (existingUser) {
    throw new ConflictError('User already exists for this application');
  }

  const hashedPassword = await hashPassword(newPassword);

  const user = await User.create({
    name: application.name,
    email: application.email,
    phone: application.phone,
    password: hashedPassword,
    role: 'MEMBER'
  });

  application.activationToken = null;
  application.activationTokenExpiresAt = null;
  await application.save();

  return ResponseHandler.success(res, {
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role
    }
  }, 'Password set and account activated successfully', 200);
});

/**
 * Verify OTP
 * @route POST /api/auth/verify-otp
 */
const verifyOTP = asyncHandler(async (req, res) => {
  const { email, otp } = req.body || {};

  if (!email || !otp) {
    throw new ValidationError('Email and OTP are required');
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  if (user.isVerified) {
    throw new ValidationError('User already verified');
  }

  if (user.otp !== otp) {
    throw new UnauthorizedError('Invalid OTP');
  }

  if (user.otpExpiresAt < new Date()) {
    throw new UnauthorizedError('OTP expired');
  }

  // Update user to verified (store password later at login/set-password? For now clear OTP)
  user.isVerified = true;
  user.otp = null;
  user.otpExpiresAt = null;
  user.role = user.role === 'PENDING' ? 'MEMBER' : user.role; // promote from PENDING
  await user.save();

  // Generate tokens
  const tokens = jwtUtils.generateTokens(user.id, {
    email: user.email,
    role: user.role
  });

  return ResponseHandler.success(res, {
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role
    },
    tokens
  }, 'Email verified successfully');
});

/**
 * Resend OTP
 * @route POST /api/auth/resend-otp
 */
const resendOTP = asyncHandler(async (req, res) => {
  const { email } = req.body || {};

  if (!email) {
    throw new ValidationError('Email is required');
  }

  const user = await User.findOne({ where: { email } });
  if (!user) {
    throw new UnauthorizedError('User not found');
  }

  if (user.isVerified) {
    throw new ValidationError('User already verified');
  }

  // Generate new OTP
  const newOtp = generateOTP();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  user.otp = newOtp;
  user.otpExpiresAt = otpExpiresAt;
  await user.save();

  // Send new OTP
  await sendOTP(email, newOtp);

  return ResponseHandler.success(res, {
    message: 'New OTP sent to your email'
  }, 'OTP resent successfully');
});

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
  refreshToken,
  logoutUser,
  registerUser,
  verifyOTP,
  resendOTP,
  setPassword
};


