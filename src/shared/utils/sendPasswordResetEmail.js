const { Resend } = require('resend');

const buildResetPasswordEmailTemplate = ({ recipientName, resetUrl, expiresInMinutes }) => `
  <div style="margin:0;background-color:#f4f7fb;padding:32px 16px;font-family:Arial,sans-serif;color:#14213d;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e5e7eb;">
      <p style="margin:0 0 12px;font-size:14px;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Ayedos Account Security</p>
      <h1 style="margin:0 0 16px;font-size:28px;line-height:1.2;color:#111827;">Reset your password</h1>
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hello ${recipientName},</p>
      <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">
        We received a request to reset your password. Use the button below to choose a new one. This link expires in ${expiresInMinutes} minutes.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${resetUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:700;">Reset Password</a>
      </p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151;">
        If the button does not work, copy and paste this link into your browser:
      </p>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;word-break:break-all;color:#0f766e;">${resetUrl}</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">
        If you did not request this change, you can safely ignore this email.
      </p>
    </div>
  </div>
`;

const sendPasswordResetEmail = async ({ to, recipientName, resetUrl, expiresInMinutes }) => {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('Email service not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  await resend.emails.send({
    from,
    to,
    subject: 'Reset your Ayedos password',
    html: buildResetPasswordEmailTemplate({
      recipientName,
      resetUrl,
      expiresInMinutes
    })
  });
};

module.exports = {
  sendPasswordResetEmail,
  buildResetPasswordEmailTemplate
};
