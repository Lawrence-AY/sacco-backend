const asyncHandler = require("express-async-handler");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

// Import User model
const User = require("../../models/user.model");

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });
};

// Protect routes - verify JWT token
const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      // Get token from header
      token = req.headers.authorization.split(" ")[1];

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Get user from the token
      req.user = await User.findByPk(decoded.id);

      if (!req.user) {
        return res.status(401).json({ message: "User not found" });
      }

      next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  } else {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
});

// Admin middleware - check if user is admin
const admin = (req, res, next) => {
  if (req.user && req.user.role === "ADMIN") {
    next();
  } else {
    return res.status(403).json({ message: "Not authorized as an admin" });
  }
};

// Finance middleware - check if user is finance or admin
const finance = (req, res, next) => {
  if (req.user && (req.user.role === "ADMIN" || req.user.role === "FINANCE")) {
    next();
  } else {
    return res.status(403).json({ message: "Not authorized as finance/admin" });
  }
};

// Member middleware - check if user is member
const member = (req, res, next) => {
  if (req.user && req.user.role === "MEMBER") {
    next();
  } else {
    return res.status(403).json({ message: "Not authorized as a member" });
  }
};

// @desc    Login user & get token
// @route   POST /api/auth/login
// @access  Public
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Validate input
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  // Find user by email
  const user = await User.findOne({ where: { email } });

  if (!user) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  // Compare passwords using bcrypt
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (isPasswordValid) {
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user.id),
    });
  } else {
    res.status(401).json({ message: "Invalid credentials" });
  }
});

// @desc    Hash password
// @access  Private
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

module.exports = { protect, admin, finance, member, loginUser, generateToken, hashPassword };


