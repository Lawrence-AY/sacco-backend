const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const memberController = require('../controllers/memberController');

const router = express.Router();
router.use(protect, authorize(['MEMBER', 'ADMIN']));

router.get('/profile', memberController.getProfile);
router.put('/profile', validate(schemas.profileUpdate), memberController.updateProfile);
router.get('/loans', memberController.getLoans);
router.post('/loans', validate(schemas.loanRequest), memberController.applyForLoan);
router.post('/loans/:loanId/cancel', memberController.cancelLoan);
router.post('/loans/:loanId/repay', validate(schemas.moneyAction), memberController.repayLoan);
router.post('/savings/deposit', validate(schemas.moneyAction), memberController.depositSavings);
router.get('/shares', memberController.getShares);
router.post('/shares', validate(schemas.sharesPurchase), memberController.buyShares);
router.get('/transactions', memberController.getTransactions);
router.get('/guarantees', memberController.getGuarantees);
router.post('/reports/email', memberController.emailReport);

module.exports = router;
