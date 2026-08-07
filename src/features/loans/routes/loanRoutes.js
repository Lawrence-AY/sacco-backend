const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const loanController = require('../controllers/loanController');

router.get('/guarantor-requests/:token', loanController.getGuarantorRequest);
router.post('/guarantor-requests/:token/respond', loanController.respondToGuarantorRequest);

// All routes require authentication
router.use(protect);

// Routes
router.get('/', loanController.getLoans);
router.get('/:id', loanController.getLoanById);
router.post('/', validate(schemas.loanRequest), loanController.createLoan);
router.put('/:id', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), validate(schemas.loanRequest), loanController.updateLoan);
router.patch('/:loanId/approve', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), loanController.approveLoan);
router.put('/:id/approve', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), loanController.approveLoan);
router.patch('/:loanId/reject', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), loanController.rejectLoan);
router.put('/:id/reject', authorize(['ADMIN', 'FINANCE', 'SUPERADMIN']), loanController.rejectLoan);
router.delete('/:id', authorize(['ADMIN', 'SUPERADMIN']), loanController.deleteLoan);

module.exports = router;
