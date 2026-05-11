const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const financeController = require('../controllers/financeController');

const router = express.Router();
router.use(protect, authorize(['ADMIN', 'FINANCE']));

router.get('/transactions', financeController.getAllTransactions);
router.post('/transactions', financeController.createTransaction);
router.post('/transactions/:transactionId/verify', financeController.verifyTransaction);
router.post('/transactions/:transactionId/void', financeController.voidTransaction);

router.get('/loans', financeController.getAllLoans);
router.get('/loans/:loanId', financeController.getLoanById);
router.post('/loans/:loanId/approve', financeController.approveLoan);
router.post('/loans/:loanId/reject', financeController.rejectLoan);
router.post('/loans/:loanId/disburse', financeController.disburseLoan);

router.get('/shares', financeController.getAllShares);
router.get('/shares/member/:memberId', financeController.getMemberShares);
router.post('/shares', financeController.purchaseShares);

router.get('/dividends', financeController.getAllDividends);
router.post('/dividends', financeController.declareDividend);

router.get('/deductions', financeController.getAllDeductions);
router.post('/deductions', financeController.createDeduction);
router.put('/deductions/:deductionId', financeController.updateDeduction);

module.exports = router;
