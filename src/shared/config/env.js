const { isProduction } = require('./security');

const requiredAlways = [
  'DATABASE_URL',
];

const requiredProduction = [
  'FRONTEND_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
];

const weakValues = new Set([
  'your-secret-key-change-in-production',
  'your-super-secure-jwt-secret-here',
  'your-refresh-token-secret-here',
  'secret',
  'password',
]);

const validateEnvironment = () => {
  const required = [...requiredAlways, ...(isProduction ? requiredProduction : [])];
  const missing = required.filter((key) => !process.env[key]);
  const weakSecrets = isProduction ? ['JWT_SECRET', 'JWT_REFRESH_SECRET'].filter((key) => {
    const value = process.env[key];
    return !value || value.length < 32 || weakValues.has(value);
  }) : [];

  const errors = [];
  if (missing.length) {
    errors.push(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (weakSecrets.length) {
    errors.push(`Weak or missing JWT secrets: ${weakSecrets.join(', ')}`);
  }
  if (isProduction && process.env.CORS_ORIGIN === '*') {
    errors.push('CORS_ORIGIN="*" is not allowed in production');
  }

  if (errors.length) {
    throw new Error(errors.join('; '));
  }
};

module.exports = {
  validateEnvironment,
};
