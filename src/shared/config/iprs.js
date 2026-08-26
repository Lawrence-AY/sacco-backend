const truthy = new Set(['1', 'true', 'yes', 'on']);

const isEnabled = () => truthy.has(String(process.env.IPRS_ENABLED || '').trim().toLowerCase());

module.exports = {
  enabled: isEnabled(),
  url: String(process.env.IPRS_URL || '').trim().replace(/\/+$/, ''),
  username: process.env.IPRS_USERNAME || '',
  password: process.env.IPRS_PASSWORD || '',
  authPath: process.env.IPRS_AUTH_PATH || '/api/v1/auth/session',
  verifyPath: process.env.IPRS_VERIFY_PATH || '/api/v1/iprs/verify/id',
  tokenRefreshSkewMs: 60 * 1000,
};
