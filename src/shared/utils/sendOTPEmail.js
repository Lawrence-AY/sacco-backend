const { getTransporter, emailLogger } = require('../config/emailConfig');
const { Resend } = require('resend');

const buildOtpEmailTemplate = (otp) => `
  <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
    <div style="text-align: center; padding: 20px 0;">
      <h2 style="color: #333;">Login Verification</h2>
    </div>

    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px;">
      <p style="font-size: 14px; color: #666;">
        Please use the verification code below to complete your login:
      </p>

      <div style="
        font-size: 36px;
        font-weight: bold;
        letter-spacing: 8px;
        margin: 30px 0;
        text-align: center;
        color: #2c3e50;
        font-family: 'Courier New', monospace;
        background-color: #ecf0f1;
        padding: 15px;
        border-radius: 4px;
      ">
        ${otp}
      </div>

      <p style="font-size: 13px; color: #888; text-align: center;">
        This verification code expires in 10 minutes.
      </p>
    </div>

    <div style="text-align: center; padding: 20px 0; font-size: 12px; color: #999;">
      <p>If you didn't request this code, please ignore this email.</p>
    </div>
  </div>
`;

const sendViaResend = async (email, otp) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Resend API key is not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const result = await resend.emails.send({
    from,
    to: email,
    subject: 'Your Ayedos SACCO login code',
    html: buildOtpEmailTemplate(otp)
  });

  emailLogger.info('OTP email sent successfully via Resend', {
    to: email,
    id: result?.data?.id
  });

  return result;
};

/**
 * Send OTP email to user
 * Validation happens at send time, not at import time
 * This allows the app to start even if SMTP config is missing
 */
const sendOTPEmail = async (email, otp) => {
  if (!email || !otp) {
    emailLogger.error('Invalid email send request', { email: email ? '✓' : '✗', otp: otp ? '✓' : '✗' });
    throw new Error('Email and OTP are required');
  }

  try {
    emailLogger.info('Attempting to send OTP email', { to: email, otpLength: otp.toString().length });

    // Get transporter - this will throw if SMTP config is invalid
    const transporter = getTransporter();

    const mailOptions = {
      from: `"Ayedos SACCO" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Ayedos SACCO login code',
      html: buildOtpEmailTemplate(otp)
    };

    // Send email with timeout
    const result = await Promise.race([
      transporter.sendMail(mailOptions),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Email send timeout')), 30000)
      )
    ]);

    emailLogger.info('OTP email sent successfully', {
      to: email,
      messageId: result.messageId
    });

    return result;

  } catch (error) {
    emailLogger.error('Failed to send OTP email via SMTP', {
      to: email,
      error: error.message,
      code: error.code,
      command: error.command
    });

    if (process.env.RESEND_API_KEY) {
      emailLogger.info('Attempting OTP email fallback via Resend', { to: email });
      return sendViaResend(email, otp);
    }

    throw error;
  }
};

module.exports = sendOTPEmail;
module.exports.buildOtpEmailTemplate = buildOtpEmailTemplate;
