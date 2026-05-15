const loanService = require('../services/loanService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');
const { LoanDTO } = require('../../../shared/utils/dtos');

/**
 * Get all loans
 * @route   GET /api/loans
 * @access  Private
 */
const getLoans = asyncHandler(async (req, res) => {
  const loans = await loanService.getAllLoans();
  return ResponseHandler.success(res, loans.map((loan) => LoanDTO.basic(loan, req.user)), 'Loans retrieved successfully', 200);
});

/**
 * Get loan by ID
 * @route   GET /api/loans/:id
 * @access  Private
 */
const getLoanById = asyncHandler(async (req, res) => {
  const loan = await loanService.getLoanById(req.params.id);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  return ResponseHandler.success(res, LoanDTO.basic(loan, req.user), 'Loan retrieved successfully', 200);
});

/**
 * Create new loan
 * @route   POST /api/loans
 * @access  Member
 */
const createLoan = asyncHandler(async (req, res) => {
  if (!req.body.memberId || !req.body.amount || !req.body.type) {
    throw new ValidationError('MemberId, amount, and type are required');
  }
  const loan = await loanService.createLoan(req.body);
  return ResponseHandler.created(res, LoanDTO.basic(loan, req.user), 'Loan created successfully');
});

/**
 * Update loan
 * @route   PUT /api/loans/:id
 * @access  Admin/Finance
 */
const updateLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.updateLoan(req.params.id, req.body);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  return ResponseHandler.success(res, LoanDTO.basic(loan, req.user), 'Loan updated successfully', 200);
});

/**
 * Approve loan
 * @route   PUT /api/loans/:id/approve
 * @access  Admin/Finance
 */
const approveLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.updateLoanStatus(req.params.id, 'APPROVED');
  return ResponseHandler.success(res, LoanDTO.basic(loan, req.user), 'Loan approved successfully', 200);
});

/**
 * Reject loan
 * @route   PUT /api/loans/:id/reject
 * @access  Admin/Finance
 */
const rejectLoan = asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    throw new ValidationError('Rejection reason is required');
  }
  const loan = await loanService.updateLoanStatus(req.params.id, 'REJECTED', req.body.reason);
  return ResponseHandler.success(res, LoanDTO.basic(loan, req.user), 'Loan rejected successfully', 200);
});

/**
 * Delete loan
 * @route   DELETE /api/loans/:id
 * @access  Admin
 */
const deleteLoan = asyncHandler(async (req, res) => {
  const result = await loanService.deleteLoan(req.params.id);
  if (!result) {
    throw new NotFoundError('Loan not found');
  }
  return ResponseHandler.noContent(res);
});

module.exports = {
  getLoans,
  getLoanById,
  createLoan,
  updateLoan,
  approveLoan,
  rejectLoan,
  deleteLoan,
};
