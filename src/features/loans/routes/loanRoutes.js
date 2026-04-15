const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const loanController = require('../controllers/loanController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', loanController.getLoans);
router.get('/:id', loanController.getLoanById);
router.post('/', loanController.createLoan);
router.put('/:id', authorize(['ADMIN', 'FINANCE']), loanController.updateLoan);
router.put('/:id/approve', authorize(['ADMIN', 'FINANCE']), loanController.approveLoan);
router.put('/:id/reject', authorize(['ADMIN', 'FINANCE']), loanController.rejectLoan);
router.delete('/:id', authorize(['ADMIN']), loanController.deleteLoan);

module.exports = router;
