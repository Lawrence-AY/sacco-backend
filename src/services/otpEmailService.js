// services/emailService.js
const { createClient } = require('@supabase/supabase-js');

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
    console.error('Supabase OTP failed:', error.message);
    throw new Error(error.message);
  }

  console.log(`✅ OTP sent to ${email}`);
};

module.exports = { sendOTP };