const { createClient } = require('@supabase/supabase-js');

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

    console.debug('[AUTH] Supabase OTP response received');

    if (error) {
      console.error('[AUTH] Supabase OTP error', { message: error.message });
      throw new Error(error.message);
    }

    console.info('[AUTH] OTP email sent');

    return data;
  } catch (err) {
    console.error('[AUTH] Failed to send OTP', { message: err.message });
    throw err;
  }
};

module.exports = { sendOTP };
