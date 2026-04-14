const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');

router.get('/', loanController.getLoans);
router.get('/:id', loanController.getLoanById);
router.post('/', loanController.createLoan);
router.patch('/:id', loanController.updateLoan);
router.patch('/:id/approve', loanController.approveLoan);
router.patch('/:id/reject', loanController.rejectLoan);

module.exports = router;
