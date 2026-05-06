const express = require('express');
const { forgotPassword, resetPassword } = require('../controllers/passwordResetController');
const { forgotPasswordRateLimiter } = require('../../../shared/middleware/passwordResetRateLimit');

const router = express.Router();

router.post('/forgot-password', forgotPasswordRateLimiter, forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;
