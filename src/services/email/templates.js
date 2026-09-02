const fs = require('fs');
const path = require('path');

const BRAND_LOGO_CID = 'ayedos-sacco-logo';
const BRAND_DARK_LOGO_CID = 'ayedos-sacco-logo-dark';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Email runs from the backend, while the approved logo assets live in the web app.
const resolveLogoPath = (fileName) => path.resolve(__dirname, '../../../../ayedos-webapp/src/assets', fileName);

const getBrandLogoAttachments = () => [
  { fileName: 'logo-light.png', cid: BRAND_LOGO_CID },
  { fileName: 'logo.png', cid: BRAND_DARK_LOGO_CID },
].map(({ fileName, cid }) => {
  const logoPath = resolveLogoPath(fileName);
  if (!fs.existsSync(logoPath)) return null;
  return {
    filename: fileName,
    path: logoPath,
    cid,
    contentType: 'image/png',
  };
}).filter(Boolean);

const brandEmailStyles = `
  <style>
    .ayedos-logo-dark { display:none; max-height:0; overflow:hidden; }
    @media (prefers-color-scheme: dark) {
      .ayedos-email-body { background:#0f172a !important; }
      .ayedos-email-card { background:#111827 !important; border-color:#243044 !important; }
      .ayedos-email-panel { background:#172033 !important; border-color:#2a3a53 !important; }
      .ayedos-email-code-panel { background:#172033 !important; border-color:#2a3a53 !important; }
      .ayedos-email-notice { background:transparent !important; }
      .ayedos-email-code-box { background:#0f172a !important; border-color:#334155 !important; color:#e2e8f0 !important; }
      .ayedos-email-title { color:#93b6d9 !important; }
      .ayedos-email-text { color:#cbd5e1 !important; }
      .ayedos-email-muted { color:#94a3b8 !important; }
      .ayedos-email-strong { color:#e2e8f0 !important; }
      .ayedos-email-footer { background:#111827 !important; border-color:#243044 !important; }
      .ayedos-logo-light { display:none !important; max-height:0 !important; overflow:hidden !important; }
      .ayedos-logo-dark { display:block !important; max-height:none !important; overflow:visible !important; }
    }
  </style>
`;

const brandLogoHtml = `
  <img class="ayedos-logo-light" src="cid:${BRAND_LOGO_CID}" alt="AYEDOS SACCO" width="200" style="display:block;max-width:200px;height:auto;margin:0 auto" />
  <img class="ayedos-logo-dark" src="cid:${BRAND_DARK_LOGO_CID}" alt="AYEDOS SACCO" width="200" style="display:none;max-width:200px;height:auto;margin:0 auto" />
`;

const buildBrandedEmail = ({ children, footer = 'This is an automated email. Replies to this address are not monitored.' }) => `
  ${brandEmailStyles}
  <div class="ayedos-email-body" style="margin:0;padding:0;background:#eaf0f6;font-family:Arial,Helvetica,sans-serif;color:#24384d">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="ayedos-email-body" style="border-collapse:collapse;background:#eaf0f6;padding:18px 0">
      <tr>
        <td align="center" style="padding:16px 12px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="ayedos-email-card" style="max-width:700px;border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:34px;background:#ffffff;border:1px solid #e8eef5">
            <tr>
      <td align="center" style="padding:30px 32px 16px;background:transparent">${brandLogoHtml}</td>
            </tr>
            ${children}
            <tr>
      <td class="ayedos-email-footer" align="center" style="padding:20px 30px 24px;background:#ffffff;border-top:1px solid #e6edf5">
                <p class="ayedos-email-muted" style="margin:0;font-size:13px;line-height:1.6;color:#8298b1">${escapeHtml(footer)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
`;

const buildOtpEmail = ({ otp, recipientName }) => {
  const safeOtp = escapeHtml(otp);
  const safeRecipientName = escapeHtml(recipientName || 'Member');

  return buildBrandedEmail({
    footer: 'This is an automated verification email. Replies to this address are not monitored. © 2026 CMPL. All rights reserved.',
    children: `
            <tr>
              <td style="padding:8px 40px 24px">
                <p class="ayedos-email-strong" style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#24384d">Hello ${safeRecipientName},</p>
                <p class="ayedos-email-text" style="margin:0;font-size:15px;line-height:1.65;color:#5f748c">Use the verification code below to continue. For your security, this code expires in 10 minutes.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 20px">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="ayedos-email-code-panel" style="border-collapse:separate;border-spacing:0;border-radius:28px;background:#f7f9fc;border:1px solid #d8dee7">
                  <tr>
                    <td align="center" style="padding:25px 24px 24px">
                      <div class="ayedos-email-text" style="font-size:14px;font-weight:500;color:#5f748c">Verification Code (OTP)</div>
                      <div class="ayedos-email-code-box" style="display:inline-block;margin-top:17px;padding:16px 28px;border-radius:12px;background:#ffffff;border:1px solid #9aa8b8;color:#101827;font-size:28px;line-height:1;font-weight:800;letter-spacing:10px">${safeOtp}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 34px">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="ayedos-email-notice" style="border-collapse:separate;border-spacing:0;background:transparent">
                  <tr>
                    <td align="center" style="padding:0 20px">
                      <p class="ayedos-email-text" style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#5f748c">For your security, do not share this code with anyone.</p>
                      <p class="ayedos-email-text" style="margin:0;font-size:13px;line-height:1.55;color:#5f748c"><strong class="ayedos-email-strong" style="color:#24384d">Didn't request this?</strong> If you didn't attempt to verify your email, you can safely ignore this message. No action is required.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
    `,
  });
};

const buildReportEmail = ({ recipientName, reportType, summaryRows = [] }) => buildBrandedEmail({
  children: `
    <tr>
      <td style="padding:0 40px 34px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="ayedos-email-panel" style="border-collapse:separate;border-spacing:0;border-radius:24px;background:#f7f9fc;border:1px solid #e6edf5">
          <tr>
            <td style="padding:30px 32px">
              <div class="ayedos-email-title" style="font-size:14px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#5b82aa">AYEDOS SACCO ${escapeHtml(reportType)}</div>
              <h1 class="ayedos-email-strong" style="margin:12px 0 8px;font-size:24px;line-height:1.25;color:#24384d">Your report is ready</h1>
              <p class="ayedos-email-text" style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#5f748c">Hello ${escapeHtml(recipientName || 'Member')}, your requested report is attached as a PDF.</p>
              ${summaryRows.length ? `
                <div style="margin-top:18px">
                  ${summaryRows.map(([label, value]) => `
                    <p class="ayedos-email-text" style="margin:0 0 8px;font-size:14px;line-height:1.45;color:#5f748c">
                      <strong class="ayedos-email-strong" style="color:#24384d">${escapeHtml(label)}:</strong>
                      ${escapeHtml(value)}
                    </p>
                  `).join('')}
                </div>
              ` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `,
});

const buildNewDeviceEmail = ({ recipientName, session }) => {
  const rows = [
    ['Device', session.deviceName || 'Unknown device'],
    ['Browser / User agent', session.userAgent || 'Unknown browser'],
    ['IP address', session.ipAddress || 'Unknown IP'],
    ['Approx. location', session.location || 'Location unavailable'],
    ['Time', new Date(session.loginAt || Date.now()).toLocaleString()],
  ].map(([label, value]) => `
    <tr>
      <td style="padding:7px 0;color:#64748b;font-size:13px;font-weight:700">${escapeHtml(label)}</td>
      <td style="padding:7px 0;color:#24384d;font-size:13px;text-align:right">${escapeHtml(value)}</td>
    </tr>
  `).join('');

  return buildBrandedEmail({
    children: `
      <tr>
        <td style="padding:0 28px 20px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="ayedos-email-panel" style="border-collapse:separate;border-spacing:0;border-radius:24px;background:#f7f9fc;border:1px solid #e6edf5">
            <tr>
              <td style="padding:24px 26px">
                <div class="ayedos-email-title" style="font-size:14px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#5b82aa">Security Alert</div>
                <h1 class="ayedos-email-strong" style="margin:12px 0 8px;font-size:24px;line-height:1.25;color:#24384d">New device login detected</h1>
                <p class="ayedos-email-text" style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#5f748c">Hello ${escapeHtml(recipientName || 'Member')}, your AYEDOS SACCO account was accessed using a device we have not seen before.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows}</table>
                <p class="ayedos-email-strong" style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#24384d;font-weight:800">If this was not you, change your password immediately.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `,
  });
};

const buildPasswordResetEmail = ({ recipientName, resetUrl, expiresInMinutes }) => `
  <div style="font-family:Arial,sans-serif;color:#14213d">
    <h2>Reset your AYEDOS password</h2>
    <p>Hello ${recipientName},</p>
    <p>Use the link below within ${expiresInMinutes} minutes:</p>
    <p><a href="${resetUrl}">Reset password</a></p>
    <p>If you did not request this change, ignore this email.</p>
  </div>
`;

module.exports = {
  buildOtpEmail,
  buildPasswordResetEmail,
  buildReportEmail,
  buildNewDeviceEmail,
  getBrandLogoAttachments,
};
