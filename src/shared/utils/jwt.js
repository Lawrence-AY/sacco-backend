const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '30d';
const REFRESH_TOKEN_EXPIRE = process.env.REFRESH_TOKEN_EXPIRE || '7d';

/**
 * Generate access token
 * @param {string} userId - User ID
 * @param {object} additionalData - Additional data to include in token
 * @returns {string} JWT token
 */
const generateAccessToken = (userId, additionalData = {}) => {
  try {
    return jwt.sign(
      {
        id: userId,
        type: 'access',
        ...additionalData
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRE }
    );
  } catch (error) {
    throw new Error(`Failed to generate access token: ${error.message}`);
  }
};

/**
 * Generate refresh token
 * @param {string} userId - User ID
 * @returns {string} JWT refresh token
 */
const generateRefreshToken = (userId) => {
  try {
    return jwt.sign(
      {
        id: userId,
        type: 'refresh'
      },
      JWT_SECRET,
      { expiresIn: REFRESH_TOKEN_EXPIRE }
    );
  } catch (error) {
    throw new Error(`Failed to generate refresh token: ${error.message}`);
  }
};

/**
 * Verify token
 * @param {string} token - JWT token
 * @returns {object} Decoded token
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    }
    if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid token');
    }
    throw error;
  }
};

/**
 * Generate both access and refresh tokens
 * @param {string} userId - User ID
 * @param {object} additionalData - Additional data to include in access token
 * @returns {object} Object with access and refresh tokens
 */
const generateTokens = (userId, additionalData = {}) => {
  return {
    accessToken: generateAccessToken(userId, additionalData),
    refreshToken: generateRefreshToken(userId)
  };
};

/**
 * Decode token without verification (for logging/debugging)
 * @param {string} token - JWT token
 * @returns {object} Decoded token
 */
const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch (error) {
    return null;
  }
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  verifyToken,
  decodeToken
};
