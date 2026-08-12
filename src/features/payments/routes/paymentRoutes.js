const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const paymentController = require('../controllers/paymentController');

const router = express.Router();

router.use(protect, authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']));
router.post('/', paymentController.createPayment);

module.exports = router;
