// services/emailService.js
const { createClient } = require('@supabase/supabase-js');
const logger = require('../shared/utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Send OTP via Supabase
 */
const sendOTP = async (email, metadata = {}) => {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { 
      shouldCreateUser: true,
      data: metadata
    }
  });

  if (error) {
    logger.error('Supabase OTP failed', { module: 'auth', error: error.message });
    throw new Error(error.message);
  }

  logger.info('OTP email sent', { module: 'auth' });
};

module.exports = { sendOTP };
