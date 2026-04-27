const bcrypt = require('bcrypt');
const jwtUtils = require('../utils/jwt');
const ResponseHandler = require('../utils/response');
const { UnauthorizedError, ForbiddenError, ValidationError } = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');

// Import User model
const User = require('../../models/user.model');

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
  const { email, password } = req.body;

  // Validate input
  if (!email || !password) {
    throw new ValidationError('Email and password are required');
  }

  // Find user by email
  const user = await User.findOne({ where: { email } });

  if (!user) {
    throw new UnauthorizedError('Invalid email or password');
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
      name: user.name,
      email: user.email,
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
  const { refreshToken } = req.body;

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
  const { name, email, password, phone, role = 'MEMBER' } = req.body;

  // Validate input
  if (!name || !email || !password) {
    throw new ValidationError('Name, email, and password are required');
  }

  // Check if user already exists
  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new ValidationError('User with this email already exists', { email: 'Email already in use' });
  }

  // Hash password
  const hashedPassword = await hashPassword(password);

  // Create user
  const user = await User.create({
    name,
    email,
    password: hashedPassword,
    phone,
    role
  });

  // Generate tokens
  const tokens = jwtUtils.generateTokens(user.id, {
    email: user.email,
    role: user.role
  });

  return ResponseHandler.created(res, {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone
    },
    tokens,
  }, 'User registered successfully');
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
  registerUser
};


