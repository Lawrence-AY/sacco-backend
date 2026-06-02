const buildOtpEmail = ({ otp }) => `
  <div style="font-family:Arial,sans-serif;color:#14213d">
    <h2>AYEDOS SACCO verification code</h2>
    <p>Use this one-time code to continue:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px">${otp}</p>
    <p>This code expires in 10 minutes. Do not share it with anyone.</p>
  </div>
`;

const buildPasswordResetEmail = ({ recipientName, resetUrl, expiresInMinutes }) => `
  <div style="font-family:Arial,sans-serif;color:#14213d">
    <h2>Reset your AYEDOS password</h2>
    <p>Hello ${recipientName},</p>
    <p>Use the link below within ${expiresInMinutes} minutes:</p>
    <p><a href="${resetUrl}">Reset password</a></p>
    <p>If you did not request this change, ignore this email.</p>
  </div>
`;

module.exports = { buildOtpEmail, buildPasswordResetEmail };
