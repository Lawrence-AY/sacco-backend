const express = require('express');
const { protect } = require('../../../shared/middleware/authMiddleware');
const walletController = require('../controllers/walletController');

const router = express.Router();

router.use(protect);

router.post('/withdraw/mpesa', walletController.withdrawMpesa);
router.get('/:wallet_id/summary', walletController.getSummary);

module.exports = router;
