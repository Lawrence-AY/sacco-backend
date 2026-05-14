const { getTransporter, emailLogger } = require('../config/emailConfig');

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
      subject: 'Verify Your Email Address',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
          <div style="text-align: center; padding: 20px 0;">
            <h2 style="color: #333;">Email Verification</h2>
          </div>

          <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px;">
            <p style="font-size: 14px; color: #666;">
              Please use the verification code below to verify your email address:
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
              This verification code expires in <strong>10 minutes</strong>.
            </p>

            <p style="font-size: 12px; color: #aaa; text-align: center; margin-top: 15px;">
              If you did not request this email, please ignore it.
            </p>
          </div>

          <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #bbb;">
            <p>© Ayedos SACCO. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);

    emailLogger.info('OTP email sent successfully', {
      messageId: info.messageId,
      to: email,
      timestamp: new Date().toISOString()
    });

    return info;

  } catch (error) {
    emailLogger.error('Failed to send OTP email', {
      to: email,
      error: error.message,
      code: error.code,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
};

module.exports = { sendOTPEmail };
