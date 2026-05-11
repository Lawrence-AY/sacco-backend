const db = require('../../../models');
const userService = require('../../users/services/userService');
const loanService = require('../../loans/services/loanService');
const shareService = require('../../shares/services/shareService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const nodemailer = require('nodemailer');

const findMemberByUserId = async (userId) => {
  return db.Member.findOne({ where: { userId } });
};

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

const formatShareAccount = (share) => {
  const totalInvested = Number((share.shares || 0) * (share.shareValue || 0));
  return {
    id: share.id,
    memberId: share.memberId,
    shares: share.shares,
    shareValue: share.shareValue,
    totalInvested,
    purchaseDate: share.createdAt,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
};

const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, user, 'Profile retrieved successfully');
});

const updateProfile = asyncHandler(async (req, res) => {
  const updated = await userService.updateUser(req.user.id, req.body);
  if (!updated) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, updated, 'Profile updated successfully', 200);
});

const getLoans = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No loans found', 200);
  }

  const loans = await db.Loan.findAll({
    where: { memberId: member.id },
    include: [db.Guarantor],
    order: [['createdAt', 'DESC']],
  });

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

  return ResponseHandler.success(res, formatted, 'Member loans retrieved successfully', 200);
});

const applyForLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  if (!req.body.amount || !req.body.type) {
    throw new ValidationError('Loan amount and type are required');
  }

  const loan = await loanService.createLoan({
    ...req.body,
    memberId: member.id,
    status: 'PENDING',
  });

  return ResponseHandler.created(res, loan, 'Loan application submitted successfully');
});

const cancelLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }

  if (loan.memberId !== member.id) {
    throw new ForbiddenError('You do not own this loan');
  }

  if (loan.status !== 'PENDING' && loan.status !== 'APPROVED') {
    throw new ValidationError('Loan cannot be cancelled at this stage');
  }

  const updated = await loanService.updateLoanStatus(loan.id, 'REJECTED');
  return ResponseHandler.success(res, updated, 'Loan cancelled successfully', 200);
});

const getShares = asyncHandler(async (req, res) => {
  const shares = await shareService.getShareAccountsForUser(req.user);
  const formatted = shares.map(formatShareAccount);
  return ResponseHandler.success(res, formatted, 'Share accounts retrieved successfully', 200);
});

const buyShares = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const { shares, amount } = req.body;
  if (shares === undefined && amount === undefined) {
    throw new ValidationError('Shares or amount is required');
  }

  const shareAccount = await db.ShareAccount.findOne({ where: { memberId: member.id } });
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

const getTransactions = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No transactions found', 200);
  }

  const where = { memberId: member.id };
  if (req.query.type) where.type = req.query.type;

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
  }));

  return ResponseHandler.success(res, formatted, 'Transactions retrieved successfully', 200);
});

const getGuarantees = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No guarantees found', 200);
  }

  const guarantees = await db.Guarantor.findAll({
    where: { memberId: member.id },
    include: [
      { model: db.Loan, attributes: ['id', 'type', 'amount', 'status'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  const formatted = guarantees.map((guarantee) => ({
    id: guarantee.id,
    loanId: guarantee.loanId,
    amount: guarantee.amount,
    createdAt: guarantee.createdAt,
    loan: guarantee.Loan ? {
      id: guarantee.Loan.id,
      type: guarantee.Loan.type,
      amount: guarantee.Loan.amount,
      status: guarantee.Loan.status,
    } : null,
  }));

  return ResponseHandler.success(res, formatted, 'Guarantees retrieved successfully', 200);
});

const repayLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Repayment amount is required');
  }

  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  if (loan.memberId !== member.id) {
    throw new ForbiddenError('You do not own this loan');
  }
  if (!['ACTIVE', 'APPROVED'].includes(loan.status)) {
    throw new ValidationError('Loan is not eligible for repayment');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    loanId: loan.id,
    type: 'LOAN_REPAYMENT',
    amount,
    method: req.body.method || 'MANUAL',
    status: 'SUCCESS',
    reference: req.body.reference || `REPAY-${Date.now()}`
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
  }, 'Loan repayment recorded successfully');
});

const depositSavings = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Deposit amount is required');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    type: 'DEPOSIT',
    amount,
    method: req.body.method || 'MANUAL',
    status: 'SUCCESS',
    reference: req.body.reference || `DEP-${Date.now()}`
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
  }, 'Savings deposit recorded successfully');
});

const emailReport = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const reportType = req.body?.reportType || 'portfolio';
  const member = await findMemberByUserId(req.user.id);
  const transactions = member
    ? await db.Transaction.findAll({ where: { memberId: member.id }, order: [['createdAt', 'DESC']], limit: 20 })
    : [];
  const loans = member
    ? await db.Loan.findAll({ where: { memberId: member.id }, order: [['createdAt', 'DESC']] })
    : [];
  const shares = await shareService.getShareAccountsForUser(req.user);

  const shareCapital = shares.reduce((sum, share) => sum + Number((share.shares || 0) * (share.shareValue || 0)), 0);
  const outstandingLoans = loans.reduce((sum, loan) => sum + Number(loan.amount || 0), 0);
  const transactionTotal = transactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"Ayedos SACCO" <${process.env.SMTP_USER}>`,
    to: user.email,
    subject: `AYEDOS SACCO ${reportType} report`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2>AYEDOS SACCO ${reportType} report</h2>
        <p>Hello ${user.name || 'Member'},</p>
        <p>Your requested report summary is below.</p>
        <ul>
          <li><strong>Share capital:</strong> KSh ${Math.round(shareCapital).toLocaleString()}</li>
          <li><strong>Outstanding loans:</strong> KSh ${Math.round(outstandingLoans).toLocaleString()}</li>
          <li><strong>Recent transaction total:</strong> KSh ${Math.round(transactionTotal).toLocaleString()}</li>
          <li><strong>Loans:</strong> ${loans.length}</li>
          <li><strong>Transactions reviewed:</strong> ${transactions.length}</li>
        </ul>
        <p>Generated at ${new Date().toISOString()}.</p>
      </div>
    `
  });

  return ResponseHandler.success(res, null, 'Report sent to your email', 200);
});

module.exports = {
  getProfile,
  updateProfile,
  getLoans,
  applyForLoan,
  cancelLoan,
  repayLoan,
  depositSavings,
  getShares,
  buyShares,
  getTransactions,
  getGuarantees,
  emailReport,
};
