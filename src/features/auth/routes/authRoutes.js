const express = require('express');
const { forgotPassword, resetPassword, changePassword } = require('../controllers/passwordResetController');
const { forgotPasswordRateLimiter } = require('../../../shared/middleware/passwordResetRateLimit');
const { protect } = require('../../../shared/middleware/authMiddleware');

const router = express.Router();

router.post('/forgot-password', forgotPasswordRateLimiter, forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/change-password', protect, changePassword);

module.exports = router;
