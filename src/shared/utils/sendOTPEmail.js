const nodemailer = require('nodemailer');

const requiredEnv = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS'
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  throw new Error(
    `Missing SMTP configuration: ${missingEnv.join(', ')}. ` +
      'Please set these values in your .env file before sending email.'
  );
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_PORT === '465',
  pool: true,
  maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS || 3),
  maxMessages: Number(process.env.SMTP_MAX_MESSAGES || 100),
  connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 8000),
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 5000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 10000),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendOTPEmail = async (email, otp) => {
  try {
    const info = await transporter.sendMail({
      from: `"AYEDOS SACCO" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Verification Code (OTP) - AYEDOS SACCO',
      html: `
      <!-- Main Wrapper Container -->
<div style="background-color: #eef2f8; font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.5; padding: 40px 20px; min-height: 100%;">
    
    <!-- Verification Card -->
    <div class="verification-container" style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border-radius: 28px; box-shadow: 0 20px 35px -12px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.02); overflow: hidden;">
        
        <!-- Inner Content Padding -->
        <div class="content-padding" style="padding: 36px 32px 28px 32px;">
            
            <!-- Logo Area -->
            <div class="logo-wrapper" style="text-align: center; margin-bottom: 24px;">
                <img class="logo-img" src="https://sacco.ayedos.com/logos/logo-light.png" alt="AYEDOS GROUP LIMITED - official logo" width="160" style="max-width: 160px; height: auto; display: inline-block; border: none;">
            </div>

            <!-- OTP Box -->
            <div class="otp-card" style="background-color: #f8fafd; border-radius: 24px; padding: 28px 20px; margin: 20px 0; text-align: center; border: 1px solid #eef2f8;">
                <div class="otp-label" style="font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; color: #527a9b; margin-bottom: 12px;">
                    verification code (OTP)
                </div>
                <div class="otp-code" style="font-size: 24px; font-weight: 800; 
                font-family: 'SF Mono', 'Fira Code', 'Courier New', monospace; letter-spacing: 4px; 
                color: #0f2b3d; background-color: #ffffff; display: inline-block; 
                padding: 10px 24px; border-radius:10px; border: 1px solid #e2e9f2;
                 box-shadow: 0 6px 12px -8px rgba(0, 0, 0, 0.05); word-break: break-all;">
                   ${otp}
                </div>
            </div>

            <!-- Security & Info Text -->
            <div class="info-text" style="font-size: 13px; color: #5d6f83; background-color: #f4f9fe; border-radius: 16px; padding: 16px 20px; text-align: center; margin-top: 20px;">
                <p style="margin: 0 0 10px 0; font-weight: 600; color: #2c3e50;">
                    For your security, do not share this code with anyone.
                </p>
                <p style="margin: 0; line-height: 1.4;">
                    <strong style="color: #1c4e70; font-weight: 600;">Didn't request this?</strong> If you didn’t request, you can ignore this message. No action is required.
                </p>
            </div>
             
        </div>

        <!-- Legal Footer -->
        <div class="legal-footer" style="background-color: #fbfdff; border-top: 1px solid #eef2f8; padding: 20px 32px 24px 32px; font-size: 11px; line-height: 1.5; color: #8a9bb0; text-align: center; letter-spacing: 0.2px;">
            <div class="footer-disclaimer">
                This is an automated verification email. Replies to this address are not monitored.
            </div>
        </div>

    </div>
</div>     `
    });

    console.info('[AUTH] Email sent', { messageId: info.messageId });

    return info;

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
