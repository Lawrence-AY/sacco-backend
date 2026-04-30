const express = require('express');
const router = express.Router();
const { protect } = require('../../../shared/middleware/authMiddleware');

// Import controllers
const transactionController = require('../controllers/transactionController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', transactionController.getAllTransactions);
router.get('/:id', transactionController.getTransactionById);
router.post('/', transactionController.createTransaction);
router.put('/:id', transactionController.updateTransaction);
router.delete('/:id', transactionController.deleteTransaction);

module.exports = router;