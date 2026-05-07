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

    console.log(
      'Supabase OTP response:',
      JSON.stringify(data, null, 2)
    );

    if (error) {
      console.error('Supabase OTP error:', error);
      throw new Error(error.message);
    }

    console.log(`✅ OTP email sent to ${email}`);

    return data;
  } catch (err) {
    console.error('Failed to send OTP:', err.message);
    throw err;
  }
};

module.exports = { sendOTP };