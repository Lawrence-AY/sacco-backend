const jwt = require('jsonwebtoken');
const security = require('../config/security');

const JWT_SECRET = security.jwt.secret;
const JWT_REFRESH_SECRET = security.jwt.refreshSecret;
const JWT_EXPIRE = security.jwt.expiresIn;
const REFRESH_TOKEN_EXPIRE = security.jwt.refreshExpiresIn;

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
      {
        expiresIn: JWT_EXPIRE,
        issuer: security.jwt.issuer,
        audience: security.jwt.audience,
      }
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
const generateRefreshToken = (userId, additionalData = {}) => {
  try {
    return jwt.sign(
      {
        id: userId,
        type: 'refresh',
        ...additionalData
      },
      JWT_REFRESH_SECRET,
      {
        expiresIn: REFRESH_TOKEN_EXPIRE,
        issuer: security.jwt.issuer,
        audience: security.jwt.audience,
      }
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
    const decoded = jwt.decode(token);
    const secret = decoded?.type === 'refresh' ? JWT_REFRESH_SECRET : JWT_SECRET;
    return jwt.verify(token, secret, {
      issuer: security.jwt.issuer,
      audience: security.jwt.audience,
    });
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
    refreshToken: generateRefreshToken(userId, additionalData)
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
