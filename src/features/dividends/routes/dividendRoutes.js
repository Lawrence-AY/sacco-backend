const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');

// Import controllers
const dividendController = require('../controllers/dividendController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', dividendController.getAllDividends);
router.get('/:id', dividendController.getDividendById);
router.post('/', authorize(['ADMIN', 'FINANCE']), dividendController.createDividend);
router.put('/:id', authorize(['ADMIN', 'FINANCE']), dividendController.updateDividend);
router.delete('/:id', authorize(['ADMIN']), dividendController.deleteDividend);

module.exports = router;