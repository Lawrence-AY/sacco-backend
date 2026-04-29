const { Resend } = require('resend');

const sendOTP = async (email, otp) => {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set');
    throw new Error('Email service not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    await resend.emails.send({
      from:'walace.owili@cowriex.io',
      to: email,
      subject: 'Your Ayedos OTP Code',
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2>Your OTP Code</h2>
  <p>Use this one-time code to verify your email:</p>
  <div style="background: #f0f0f0; padding: 20px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 10px;">
    ${otp}
  </div>
  <p>This code expires in 10 minutes.</p>
  <p>If you didn't request this, please ignore this email.</p>
</div>`
    });
    console.log(`OTP email sent to ${email}`);
  } catch (error) {
    console.error('Email send failed:', error);
    throw new Error('Failed to send OTP email');
  }
};

module.exports = { sendOTP };