module.exports = Object.freeze({
  AUTH_INVALID: { status: 401, message: 'Invalid credentials or verification code' },
  AUTH_LOCKED: { status: 423, message: 'This account is temporarily locked. Please try again later.' },
  AUTH_OTP_INVALID: { status: 401, message: 'Invalid or expired verification code' },
  AUTH_OTP_EXPIRED: { status: 401, message: 'Invalid or expired verification code' },
  AUTH_RATE_LIMITED: { status: 429, message: 'Too many requests. Please wait before trying again.' },
  AUTH_CSRF_INVALID: { status: 403, message: 'Request could not be verified' },
  SERVER_ERROR: { status: 500, message: 'Unable to process request' },
});
