const express = require('express');
const { forgotPassword, resetPassword, changePassword } = require('../controllers/passwordResetController');
const { passwordResetLimiter } = require('../../../shared/middleware/authRateLimits');
const { protect } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');

const router = express.Router();

const authPolicyHeaders = (req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

router.use(authPolicyHeaders);

router.post('/forgot-password', passwordResetLimiter, validate(schemas.forgotPassword), forgotPassword);
router.post('/reset-password', validate(schemas.resetPassword), resetPassword);
router.post('/change-password', protect, validate(schemas.changePassword), changePassword);

module.exports = router;
