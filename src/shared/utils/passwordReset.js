const crypto = require('crypto');

const RESET_TOKEN_TTL_MINUTES = 10;
const RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MINUTES * 60 * 1000;

const normalizeEmail = (email = '') => email.trim().toLowerCase();

const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const generatePasswordResetToken = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');

  return {
    rawToken,
    hashedToken: hashResetToken(rawToken),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
  };
};

const validatePasswordStrength = (password = '') => {
  const issues = [];

  if (password.length < 8) {
    issues.push('Password must be at least 8 characters long');
  }

  if (!/[a-z]/.test(password)) {
    issues.push('Password must include at least one lowercase letter');
  }

  if (!/[A-Z]/.test(password)) {
    issues.push('Password must include at least one uppercase letter');
  }

  if (!/[0-9]/.test(password)) {
    issues.push('Password must include at least one number');
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    issues.push('Password must include at least one special character');
  }

  return issues;
};

const createLogFingerprint = (value = '') => {
  if (!value) {
    return 'missing';
  }

  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
};

module.exports = {
  RESET_TOKEN_TTL_MINUTES,
  generatePasswordResetToken,
  hashResetToken,
  normalizeEmail,
  validatePasswordStrength,
  createLogFingerprint
};
