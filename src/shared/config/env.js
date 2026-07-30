const { isProduction } = require('./security');

const requiredAlways = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
];

const requiredProduction = [
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
  if (isProduction && !process.env.FRONTEND_URL && !process.env.CLIENT_URL) {
    errors.push('Missing required environment variable: FRONTEND_URL or CLIENT_URL');
  }
  if (isProduction && !process.env.RESEND_API_KEY && !process.env.SMTP_HOST) {
    errors.push('Missing email provider configuration: RESEND_API_KEY or SMTP_HOST');
  }
  if (isProduction && process.env.RESEND_API_KEY && !process.env.RESEND_FROM_EMAIL) {
    errors.push('Missing RESEND_FROM_EMAIL for the verified production sending domain');
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
