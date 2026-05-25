const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const logger = require('./logger');

const requiredEnv = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
let transporter;

const getTransporter = () => {
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);
  if (missingEnv.length) {
    throw new Error(`Missing SMTP configuration: ${missingEnv.join(', ')}`);
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
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
  }

  return transporter;
};

const buildOtpEmailTemplate = (otp) => `
<div style="background-color:#eef2f8;font-family:Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;line-height:1.5;padding:40px 20px;min-height:100%;">
  <div style="max-width:560px;margin:0 auto;background-color:#ffffff;border-radius:28px;box-shadow:0 20px 35px -12px rgba(0,0,0,0.08),0 4px 12px rgba(0,0,0,0.02);overflow:hidden;">
    <div style="padding:36px 32px 28px 32px;">
      <div style="text-align:center;margin-bottom:24px;">
        <img src="https://sacco.ayedos.com/logos/logo-light.png" alt="AYEDOS GROUP LIMITED - official logo" width="160" style="max-width:160px;height:auto;display:inline-block;border:none;">
      </div>
      <div style="background-color:#f8fafd;border-radius:24px;padding:28px 20px;margin:20px 0;text-align:center;border:1px solid #eef2f8;">
        <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#527a9b;margin-bottom:12px;">verification code (OTP)</div>
        <div style="font-size:24px;font-weight:800;font-family:SF Mono,Fira Code,Courier New,monospace;letter-spacing:4px;color:#0f2b3d;background-color:#ffffff;display:inline-block;padding:10px 24px;border-radius:10px;border:1px solid #e2e9f2;box-shadow:0 6px 12px -8px rgba(0,0,0,0.05);word-break:break-all;">${otp}</div>
      </div>
      <div style="font-size:13px;color:#5d6f83;background-color:#f4f9fe;border-radius:16px;padding:16px 20px;text-align:center;margin-top:20px;">
        <p style="margin:0 0 10px 0;font-weight:600;color:#2c3e50;">For your security, do not share this code with anyone.</p>
        <p style="margin:0;line-height:1.4;"><strong style="color:#1c4e70;font-weight:600;">Didn't request this?</strong> You can ignore this message. No action is required.</p>
      </div>
    </div>
    <div style="background-color:#fbfdff;border-top:1px solid #eef2f8;padding:20px 32px 24px 32px;font-size:11px;line-height:1.5;color:#8a9bb0;text-align:center;letter-spacing:0.2px;">
      This is an automated verification email. Replies to this address are not monitored.
    </div>
  </div>
</div>`;

const sendViaResend = async (email, otp) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Resend email service is not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const result = await resend.emails.send({
    from,
    to: email,
    subject: 'Verification Code (OTP) - AYEDOS SACCO',
    html: buildOtpEmailTemplate(otp),
  });

  logger.info('OTP email sent via Resend', {
    module: 'auth',
    provider: 'resend',
    to: email,
    messageId: result?.data?.id,
  });

  return result;
};

const sendOTPEmail = async (email, otp) => {
  try {
    const info = await getTransporter().sendMail({
      from: `"AYEDOS SACCO" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Verification Code (OTP) - AYEDOS SACCO',
      html: buildOtpEmailTemplate(otp),
    });

    logger.info('OTP email sent via SMTP', {
      module: 'auth',
      provider: 'smtp',
      to: email,
      messageId: info.messageId,
    });

    return info;
  } catch (error) {
    logger.error('Failed to send OTP email via SMTP', {
      module: 'auth',
      provider: 'smtp',
      to: email,
      error: error.message,
      stack: error.stack,
      code: error.code,
      command: error.command,
    });

    if (process.env.RESEND_API_KEY) {
      logger.info('Attempting OTP email fallback via Resend', { module: 'auth', to: email });
      return sendViaResend(email, otp);
    }

    throw error;
  }
};

module.exports = sendOTPEmail;
module.exports.buildOtpEmailTemplate = buildOtpEmailTemplate;
