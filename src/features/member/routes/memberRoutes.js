const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const memberController = require('../controllers/memberController');

const router = express.Router();
router.use(protect, authorize(['MEMBER', 'EMPLOYEE', 'ADMIN']));

router.get('/profile', memberController.getProfile);
router.post('/profile/photo', validate(schemas.profilePhotoUpload), memberController.uploadProfilePhoto);
router.post('/profile/kyc-documents', validate(schemas.kycDocumentsUpload), memberController.uploadKycDocuments);
router.put('/profile', validate(schemas.profileUpdate), memberController.updateProfile);
router.post('/share-capital/transfers', validate(schemas.shareCapitalTransfer), memberController.transferShareCapital);
router.get('/opt-out/transferees', memberController.searchOptOutTransferees);
router.post('/opt-out/otp', memberController.sendOptOutOtp);
router.post('/opt-out', validate(schemas.memberOptOutRequest), memberController.requestOptOut);
router.get('/loans', memberController.getLoans);
router.post('/loans', validate(schemas.loanRequest), memberController.applyForLoan);
router.post('/loans/:loanId/cancel', memberController.cancelLoan);
router.post('/loans/:loanId/repay/stk', memberController.initiateLoanRepaymentStk);
router.get('/payments/status/:checkoutRequestId', memberController.getLoanPaymentStatus);
router.post('/savings/deposit', memberController.depositSavings);
router.post('/contributions', memberController.initiateContribution);
router.get('/contributions/:transactionId/status', memberController.checkContributionStatus);
router.get('/shares', memberController.getShares);
router.post('/shares', validate(schemas.sharesPurchase), memberController.buyShares);
router.get('/transactions', memberController.getTransactions);
router.get('/guarantors/search', memberController.searchGuarantors);
router.get('/guarantees', memberController.getGuarantees);
router.get('/financial-portfolio', memberController.getFinancialPortfolio);
router.post('/reports/email', validate(schemas.reportRequest), memberController.emailReport);

module.exports = router;
