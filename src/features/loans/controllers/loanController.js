const loanService = require('../services/loanService');
const db = require('../../../models');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const { LoanDTO } = require('../../../shared/utils/dtos');

/**
 * Get all loans
 * @route   GET /api/loans
 * @access  Private
 */
const getLoans = asyncHandler(async (req, res) => {
  const role = String(req.user.role || '').toUpperCase();
  let loans;
  if (['ADMIN', 'FINANCE', 'SUPERADMIN'].includes(role)) {
    loans = await loanService.getAllLoans();
  } else {
    const member = await db.Member.findOne({ where: { userId: req.user.id } });
    loans = member ? await db.Loan.findAll({
      where: { memberId: member.id },
      include: [db.Guarantor, { model: db.Member, include: [db.User] }],
      order: [['createdAt', 'DESC']],
    }) : [];
  }
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
  const role = String(req.user.role || '').toUpperCase();
  if (!['ADMIN', 'FINANCE', 'SUPERADMIN'].includes(role)) {
    const member = await db.Member.findOne({ where: { userId: req.user.id } });
    if (!member || loan.memberId !== member.id) {
      throw new ForbiddenError('You can only access your own loans');
    }
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
  const result = await loanService.createLoan(req.body);
  return ResponseHandler.created(res, {
    success: true,
    transactionId: result.transactionId,
    loanDetails: LoanDTO.basic(result.loan, req.user),
  }, result.autoApproved ? 'Emergency Loan Auto-Approved & Disbursed' : 'Loan created successfully');
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
  const loanId = req.params.loanId || req.params.id;
  const body = req.body || {};
  const loan = await loanService.updateLoanStatus(loanId, 'APPROVED', {
    approvedById: req.user.id,
    interestRate: body.interestRate,
    duration: body.duration,
    approvedAmount: body.approvedAmount,
  });
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
  const loanId = req.params.loanId || req.params.id;
  const loan = await loanService.updateLoanStatus(loanId, 'REJECTED', {
    approvedById: req.user.id,
    reason: req.body.reason,
  });
  return ResponseHandler.success(res, LoanDTO.basic(loan, req.user), 'Loan rejected successfully', 200);
});

const getGuarantorRequest = asyncHandler(async (req, res) => {
  const request = await loanService.getGuarantorRequest(req.params.token);
  if (!request) throw new NotFoundError('Guarantor request not found');

  const { guarantor, expired } = request;
  const loan = guarantor.Loan;
  const applicant = loan?.Member?.User?.name
    || [loan?.Member?.User?.firstName, loan?.Member?.User?.lastName].filter(Boolean).join(' ')
    || loan?.Member?.memberNumber
    || 'Member';

  return ResponseHandler.success(res, {
    id: guarantor.id,
    status: expired ? 'EXPIRED' : guarantor.status,
    expiresAt: guarantor.tokenExpiresAt,
    amount: guarantor.amount,
    guarantor: {
      name: guarantor.Member?.User?.name
        || [guarantor.Member?.User?.firstName, guarantor.Member?.User?.lastName].filter(Boolean).join(' ')
        || guarantor.Member?.memberNumber,
      memberNumber: guarantor.Member?.memberNumber,
    },
    loan: {
      id: loan?.id,
      type: loan?.type,
      amount: loan?.amount,
      duration: loan?.duration,
      interestRate: loan?.interestRate,
      reason: loan?.reason,
      applicant,
      createdAt: loan?.createdAt,
    },
  }, 'Guarantor request retrieved', 200);
});

const respondToGuarantorRequest = asyncHandler(async (req, res) => {
  const loan = await loanService.respondToGuarantorRequest(req.params.token, req.body.decision, req.body.amount);
  if (!loan) throw new NotFoundError('Guarantor request not found');
  return ResponseHandler.success(res, LoanDTO.basic(loan, req.user), 'Guarantor response recorded', 200);
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
  getGuarantorRequest,
  respondToGuarantorRequest,
  deleteLoan,
};
