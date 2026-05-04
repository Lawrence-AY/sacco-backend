const db = require('../../../models');
const loanService = require('../../loans/services/loanService');
const deductionService = require('../../deductions/services/deductionService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError, NotFoundError } = require('../../../shared/utils/errors');

const buildTransactionDescription = (transaction) => {
  const pieces = [transaction.type];
  if (transaction.method) {
    pieces.push(`via ${transaction.method}`);
  }
  if (transaction.reference) {
    pieces.push(`ref: ${transaction.reference}`);
  }
  return pieces.join(' | ');
};

const formatShareAccount = (share) => ({
  id: share.id,
  memberId: share.memberId,
  shares: share.shares,
  shareValue: share.shareValue,
  totalInvested: Number((share.shares || 0) * (share.shareValue || 0)),
  purchaseDate: share.createdAt,
  createdAt: share.createdAt,
  updatedAt: share.updatedAt,
});

const formatDividend = (dividend) => ({
  id: dividend.id,
  memberId: dividend.memberId,
  amount: dividend.amount,
  year: dividend.year,
  sharePercentage: dividend.sharePercentage ?? 0,
  declaredAt: dividend.createdAt,
  status: dividend.status ?? 'DECLARED',
});

const formatDeduction = (deduction, member = null) => ({
  id: deduction.id,
  memberId: deduction.memberId,
  memberName: member ? `${member.name}` : null,
  amount: deduction.contribution,
  reason: 'Salary deduction',
  date: deduction.startDate,
  isActive: deduction.isActive,
  createdAt: deduction.createdAt,
});

const getAllTransactions = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.type) {
    where.type = req.query.type;
  }
  if (req.query.status) {
    where.status = req.query.status;
  }
  const transactions = await db.Transaction.findAll({ where, order: [['createdAt', 'DESC']] });
  const formatted = transactions.map((transaction) => ({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    memberId: transaction.memberId,
    loanId: transaction.loanId,
  }));
  return ResponseHandler.success(res, formatted, 'Transactions retrieved successfully', 200);
});

const createTransaction = asyncHandler(async (req, res) => {
  if (!req.body.amount || !req.body.type) {
    throw new ValidationError('Amount and type are required');
  }
  const transaction = await db.Transaction.create({
    memberId: req.body.memberId || null,
    loanId: req.body.loanId || null,
    type: req.body.type,
    amount: req.body.amount,
    method: req.body.method || 'MANUAL',
    status: req.body.status || 'SUCCESS',
    reference: req.body.reference || null,
  });
  return ResponseHandler.created(res, {
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    memberId: transaction.memberId,
    loanId: transaction.loanId,
  }, 'Transaction created successfully');
});

const voidTransaction = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const transaction = await db.Transaction.findByPk(req.params.transactionId);
  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }
  await transaction.update({ status: 'FAILED', reference: reason || transaction.reference });
  return ResponseHandler.success(res, {
    id: transaction.id,
    status: transaction.status,
    reference: transaction.reference,
  }, 'Transaction voided successfully', 200);
});

const getAllLoans = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  const loans = await db.Loan.findAll({ where, include: [db.Guarantor], order: [['createdAt', 'DESC']] });
  const formatted = loans.map((loan) => ({
    id: loan.id,
    memberId: loan.memberId,
    type: loan.type,
    principal: loan.amount,
    balance: loan.amount,
    status: loan.status,
    approvedAt: loan.updatedAt,
    createdAt: loan.createdAt,
    guarantors: loan.Guarantors || [],
  }));
  return ResponseHandler.success(res, formatted, 'Loans retrieved successfully', 200);
});

const getLoanById = asyncHandler(async (req, res) => {
  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  return ResponseHandler.success(res, {
    id: loan.id,
    memberId: loan.memberId,
    type: loan.type,
    principal: loan.amount,
    balance: loan.amount,
    status: loan.status,
    approvedAt: loan.updatedAt,
    createdAt: loan.createdAt,
    guarantors: loan.Guarantors || [],
  }, 'Loan retrieved successfully', 200);
});

const approveLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.updateLoanStatus(req.params.loanId, 'APPROVED');
  return ResponseHandler.success(res, loan, 'Loan approved successfully', 200);
});

const rejectLoan = asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    throw new ValidationError('Rejection reason is required');
  }
  const loan = await loanService.updateLoanStatus(req.params.loanId, 'REJECTED');
  return ResponseHandler.success(res, loan, 'Loan rejected successfully', 200);
});

const disburseLoan = asyncHandler(async (req, res) => {
  const loan = await loanService.updateLoanStatus(req.params.loanId, 'ACTIVE');
  return ResponseHandler.success(res, loan, 'Loan disbursed successfully', 200);
});

const getAllShares = asyncHandler(async (req, res) => {
  const shares = await db.ShareAccount.findAll({ order: [['createdAt', 'DESC']] });
  return ResponseHandler.success(res, shares.map(formatShareAccount), 'Shares retrieved successfully', 200);
});

const getMemberShares = asyncHandler(async (req, res) => {
  const share = await db.ShareAccount.findOne({ where: { memberId: req.params.memberId } });
  if (!share) {
    throw new NotFoundError('Share account not found');
  }
  return ResponseHandler.success(res, formatShareAccount(share), 'Member shares retrieved successfully', 200);
});

const purchaseShares = asyncHandler(async (req, res) => {
  const { memberId, shares, amount } = req.body;
  if (!memberId) {
    throw new ValidationError('memberId is required');
  }
  if (shares === undefined && amount === undefined) {
    throw new ValidationError('Shares or amount is required');
  }

  const shareAccount = await db.ShareAccount.findOne({ where: { memberId } });
  if (!shareAccount) {
    throw new NotFoundError('Share account not found');
  }

  const shareCount = shares !== undefined ? Number(shares) : Number(amount) / Number(shareAccount.shareValue || 1);
  if (isNaN(shareCount) || shareCount <= 0) {
    throw new ValidationError('Invalid share quantity or amount');
  }

  await shareAccount.update({ shares: shareAccount.shares + shareCount });
  return ResponseHandler.success(res, formatShareAccount(shareAccount), 'Shares purchased successfully', 200);
});

const getAllDividends = asyncHandler(async (req, res) => {
  const dividends = await db.Dividend.findAll({ order: [['createdAt', 'DESC']] });
  return ResponseHandler.success(res, dividends.map(formatDividend), 'Dividends retrieved successfully', 200);
});

const declareDividend = asyncHandler(async (req, res) => {
  if (!req.body.memberId || !req.body.amount) {
    throw new ValidationError('memberId and amount are required');
  }
  const dividend = await db.Dividend.create({
    memberId: req.body.memberId,
    amount: req.body.amount,
    year: req.body.year || new Date().getFullYear(),
  });
  return ResponseHandler.created(res, formatDividend(dividend), 'Dividend declared successfully');
});

const getAllDeductions = asyncHandler(async (req, res) => {
  const deductions = await deductionService.getSalaryDeductions();
  const formatted = await Promise.all(deductions.map(async (deduction) => {
    const member = await db.Member.findByPk(deduction.memberId);
    return formatDeduction(deduction, member);
  }));
  return ResponseHandler.success(res, formatted, 'Deductions retrieved successfully', 200);
});

const createDeduction = asyncHandler(async (req, res) => {
  if (!req.body.memberId || !req.body.amount) {
    throw new ValidationError('memberId and amount are required');
  }
  const deduction = await deductionService.createSalaryDeduction({
    memberId: req.body.memberId,
    shareAmount: req.body.shareAmount || 0,
    contribution: req.body.amount,
    startDate: req.body.startDate || new Date(),
    isActive: req.body.isActive ?? true,
  });
  const member = await db.Member.findByPk(deduction.memberId);
  return ResponseHandler.created(res, formatDeduction(deduction, member), 'Deduction created successfully');
});

const updateDeduction = asyncHandler(async (req, res) => {
  const deduction = await deductionService.updateSalaryDeduction(req.params.deductionId, {
    shareAmount: req.body.shareAmount,
    contribution: req.body.amount,
    startDate: req.body.startDate,
    isActive: req.body.isActive,
  });

  if (!deduction) {
    throw new NotFoundError('Deduction not found');
  }

  return ResponseHandler.success(res, deduction, 'Deduction updated successfully', 200);
});

module.exports = {
  getAllTransactions,
  createTransaction,
  voidTransaction,
  getAllLoans,
  getLoanById,
  approveLoan,
  rejectLoan,
  disburseLoan,
  getAllShares,
  getMemberShares,
  purchaseShares,
  getAllDividends,
  declareDividend,
  getAllDeductions,
  createDeduction,
  updateDeduction,
};
