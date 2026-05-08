const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const memberController = require('../controllers/memberController');

const router = express.Router();
router.use(protect, authorize(['MEMBER', 'ADMIN']));

router.get('/profile', memberController.getProfile);
router.put('/profile', memberController.updateProfile);
router.get('/loans', memberController.getLoans);
router.post('/loans', memberController.applyForLoan);
router.post('/loans/:loanId/cancel', memberController.cancelLoan);
router.post('/loans/:loanId/repay', memberController.repayLoan);
router.post('/savings/deposit', memberController.depositSavings);
router.get('/shares', memberController.getShares);
router.post('/shares', memberController.buyShares);
router.get('/transactions', memberController.getTransactions);
router.get('/guarantees', memberController.getGuarantees);
router.post('/reports/email', memberController.emailReport);

module.exports = router;
