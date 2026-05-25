const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Send OTP via Supabase Auth
 * @param {string} email
 */
const sendOTP = async (email) => {
  try {
    const { data, error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true
      }
    });

    logger.debug('Supabase OTP response received', { module: 'auth' });

    if (error) {
      logger.error('Supabase OTP error', { module: 'auth', error: error.message });
      throw new Error(error.message);
    }

    logger.info('Supabase OTP email sent', { module: 'auth' });

    return data;
  } catch (err) {
    logger.error('Failed to send Supabase OTP', { module: 'auth', error: err.message, stack: err.stack });
    throw err;
  }
};

module.exports = { sendOTP };
