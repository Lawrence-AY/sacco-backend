const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');

// Import controllers
const transactionController = require('../controllers/transactionController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), transactionController.getAllTransactions);
router.get('/:id', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), transactionController.getTransactionById);
router.post('/', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), validate(schemas.transaction), transactionController.createTransaction);
router.put('/:id', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), validate(schemas.transaction), transactionController.updateTransaction);
router.delete('/:id', authorize(['ADMIN', 'SUPERADMIN']), transactionController.deleteTransaction);

module.exports = router;
