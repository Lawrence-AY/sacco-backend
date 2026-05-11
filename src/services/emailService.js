// services/emailService.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Sends Supabase built-in confirmation email
 */
async function sendApplicationConfirmationEmail(email, name, applicationId) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password: crypto.randomUUID(), // required for email auth flow
    options: {
      data: {
        name,
        application_id: applicationId,
      },
    },
  });

  if (error) throw error;

  console.info('[APPLICATION] Confirmation email triggered', { applicationId });
  return data;
}

module.exports = { sendApplicationConfirmationEmail };
