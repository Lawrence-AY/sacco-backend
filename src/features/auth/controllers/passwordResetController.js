const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const User = require('../../../models/user.model');
const ResponseHandler = require('../../../shared/utils/response');
const { UnauthorizedError, ValidationError } = require('../../../shared/utils/errors');
const {
  RESET_TOKEN_TTL_MINUTES,
  createLogFingerprint,
  generatePasswordResetToken,
  hashResetToken,
  normalizeEmail,
  validatePasswordStrength
} = require('../../../shared/utils/passwordReset');
const { sendPasswordResetEmail } = require('../../../shared/utils/sendPasswordResetEmail');

const FORGOT_PASSWORD_SUCCESS_MESSAGE =
  'If an account with that email exists, a password reset link will be sent shortly.';

const forgotPassword = async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';

    if (!email) {
      throw new ValidationError('Email is required');
    }

    console.info('[AUTH] Forgot password requested', {
      emailFingerprint: createLogFingerprint(email)
    });

    const user = await User.findOne({ where: { email } });

    if (user) {
      const { rawToken, hashedToken, expiresAt } = generatePasswordResetToken();
      const frontendBaseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const resetUrl = `${frontendBaseUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;

      user.passwordResetToken = hashedToken;
      user.passwordResetExpires = expiresAt;
      await user.save({ fields: ['passwordResetToken', 'passwordResetExpires'] });

      try {
        await sendPasswordResetEmail({
          to: user.email,
          recipientName: user.firstName || user.name || 'there',
          resetUrl,
          expiresInMinutes: RESET_TOKEN_TTL_MINUTES
        });

        console.info('[AUTH] Password reset email sent', {
          userId: user.id
        });
      } catch (emailError) {
        console.error('[AUTH] Password reset email failed', {
          userId: user.id,
          message: emailError.message
        });

        user.passwordResetToken = null;
        user.passwordResetExpires = null;
        await user.save({ fields: ['passwordResetToken', 'passwordResetExpires'] });
      }
    }

    return ResponseHandler.success(res, null, FORGOT_PASSWORD_SUCCESS_MESSAGE, 200);
  } catch (error) {
    console.error('[AUTH] Forgot password failed', {
      name: error.name,
      message: error.message
    });
    return next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (!token || !newPassword) {
      throw new ValidationError('Token and new password are required');
    }

    const passwordIssues = validatePasswordStrength(newPassword);

    if (passwordIssues.length > 0) {
      throw new ValidationError('Password does not meet strength requirements', {
        password: passwordIssues
      });
    }

    const hashedToken = hashResetToken(token);

    const user = await User.findOne({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: {
          [Op.gt]: new Date()
        }
      }
    });

    if (!user) {
      console.warn('[AUTH] Invalid or expired password reset token used', {
        tokenFingerprint: createLogFingerprint(token)
      });
      throw new UnauthorizedError('Password reset token is invalid or has expired');
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save({ fields: ['password', 'passwordResetToken', 'passwordResetExpires'] });

    console.info('[AUTH] Password reset completed', {
      userId: user.id
    });

    return ResponseHandler.success(res, null, 'Password reset successful', 200);
  } catch (error) {
    console.error('[AUTH] Reset password failed', {
      name: error.name,
      message: error.message
    });
    return next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (!currentPassword || !newPassword) {
      throw new ValidationError('Current password and new password are required');
    }

    const passwordIssues = validatePasswordStrength(newPassword);
    if (passwordIssues.length > 0) {
      throw new ValidationError('Password does not meet strength requirements', {
        password: passwordIssues
      });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save({ fields: ['password'] });

    return ResponseHandler.success(res, null, 'Password changed successfully', 200);
  } catch (error) {
    console.error('[AUTH] Change password failed', {
      name: error.name,
      message: error.message
    });
    return next(error);
  }
};

module.exports = {
  forgotPassword,
  resetPassword,
  changePassword
};
