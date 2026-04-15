const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const deductionController = require('../controllers/deductionController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', authorize(['ADMIN', 'FINANCE']), deductionController.getDeductions);
router.post('/', authorize(['ADMIN', 'FINANCE']), deductionController.createDeduction);
router.patch('/:id', authorize(['ADMIN', 'FINANCE']), deductionController.updateDeduction);
router.post('/process/run', authorize(['ADMIN', 'FINANCE']), deductionController.runDeductions);

module.exports = router;
