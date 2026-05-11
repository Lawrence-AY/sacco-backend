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
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendOTPEmail = async (email, otp) => {
  try {
    const info = await transporter.sendMail({
      from: `"Ayedos SACCO" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Verify Your Email Address',
      html: `
        <div style="font-family: Arial, sans-serif;">
          <h2>Email Verification</h2>

          <p>
            Please use the verification code below:
          </p>

          <div style="
            font-size: 32px;
            font-weight: bold;
            letter-spacing: 5px;
            margin: 20px 0;
          ">
            ${otp}
          </div>

          <p>
            This OTP expires in 10 minutes.
          </p>
        </div>
      `
    });

    console.info('[AUTH] Email sent', { messageId: info.messageId });

    return info;

  } catch (error) {
    console.error('[AUTH] Email send error', { message: error.message });
    throw error;
  }
};

module.exports = { sendOTPEmail };
