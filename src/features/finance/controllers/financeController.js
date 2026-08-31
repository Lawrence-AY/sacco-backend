const db = require('../../../models');
const { calculateCurrentOutstandingBalance } = require('../../loans/services/loanCalculationEngine');
const loanService = require('../../loans/services/loanService');
const { postManualRepayment, voidRepayment } = require('../../loans/services/loanRepaymentService');
const deductionService = require('../../deductions/services/deductionService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../../shared/utils/errors');
const { LoanDTO } = require('../../../shared/utils/dtos');
const { formatEAT } = require('../../../shared/utils/eatDateTime');
const MINIMUM_SHARE_CAPITAL = 25000;

const classifyTransaction = (transaction) => {
  const source = [
    transaction.paymentCategory,
    transaction.kcbEndpoint,
    transaction.type,
    transaction.description,
  ].filter(Boolean).join(' ').toLowerCase();

  if (transaction.type === 'MEMBERSHIP_FEE' || source.includes('registration') || source.includes('membership')) {
    return { category: 'MEMBER_APPLICATION_FEE', destination: 'Member application fees' };
  }
  if (source.includes('share') || source.includes('capital')) {
    return { category: 'SHARE_CAPITAL', destination: 'Share capital account' };
  }
  if (transaction.type === 'LOAN_REPAYMENT' || source.includes('loan_repayment') || source.includes('repayment')) {
    return { category: 'LOAN_REPAYMENT', destination: 'Loan repayment account' };
  }
  if (transaction.type === 'LOAN_DISBURSEMENT' || source.includes('disbursement')) {
    return { category: 'LOAN_DISBURSEMENT', destination: 'Loan disbursement' };
  }
  if (transaction.type === 'DIVIDEND' || source.includes('dividend')) {
    return { category: 'DIVIDEND', destination: 'Dividend account' };
  }
  if (transaction.type === 'WITHDRAWAL' || source.includes('withdraw')) {
    return { category: 'WITHDRAWAL', destination: 'Member savings withdrawal' };
  }
  if (source.includes('wallet')) {
    return { category: 'WALLET', destination: 'Member wallet' };
  }
  return { category: 'SAVINGS', destination: 'Member savings account' };
};

const formatTransaction = (transaction, member = null, user = null) => {
  const classification = classifyTransaction(transaction);
  return {
    id: transaction.id,
    type: transaction.type,
    category: classification.category,
    destination: classification.destination,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    createdAtEAT: formatEAT(transaction.createdAt),
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    internalReference: transaction.internalReference,
    promptChannel: transaction.promptChannel,
    memberId: transaction.memberId,
    memberNumber: member?.memberNumber || null,
    memberName: user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || null,
    loanId: transaction.loanId,
  };
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

const formatMemberDividend = (dividend) => ({
  id: dividend.id,
  userId: dividend.userId,
  memberId: dividend.User?.Member?.id || null,
  memberNumber: dividend.User?.Member?.memberNumber || dividend.metadata?.memberNumber || '',
  memberName: dividend.User?.name || dividend.User?.email || '',
  amount: Number(dividend.dividendPaid || 0),
  totalDistributed: Number(dividend.dividendPaid || 0),
  totalShares: Number(dividend.totalShares || 0),
  year: dividend.financialYear?.year || null,
  sourceSheet: dividend.metadata?.sourceSheet || '',
  sharePercentage: 0,
  declaredAt: dividend.updatedAt,
  declaredDate: dividend.updatedAt,
  status: 'PUBLISHED',
});

const scheduledReducingBalanceInterest = (principal, monthlyRatePercent, durationMonths) => {
  const amount = Number(principal || 0);
  const periods = Number(durationMonths || 0);
  const monthlyRate = Number(monthlyRatePercent || 0) / 100;
  if (amount <= 0 || periods <= 0) return 0;
  if (monthlyRate === 0) return 0;
  const installment = (amount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -periods));
  return Math.round((installment * periods - amount) * 100) / 100;
};

const formatLoan = (loan) => {
  const member = loan.Member;
  const user = member?.User;
  const applicantName = user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || member?.memberNumber || null;
  const amount = Number(loan.amount || 0);
  const interestRate = Number(loan.interestRate || 0);
  const duration = Number(loan.duration || 0);
  const outstandingBalance = calculateCurrentOutstandingBalance(loan);
  const rawStatus = String(loan.status || '').toUpperCase();
  const financeStatus = ['PENDING', 'UNDER_REVIEW'].includes(rawStatus)
    ? 'PENDING_FINANCE'
    : ['ACTIVE', 'DISBURSED'].includes(rawStatus)
      ? 'DISBURSED'
      : rawStatus || 'PENDING_FINANCE';
  return {
    id: loan.id,
    memberId: loan.memberId,
    memberNumber: member?.memberNumber || null,
    member: applicantName,
    memberName: applicantName,
    accountInfo: {
      memberNumber: member?.memberNumber || null,
      memberStatus: member?.status || null,
      phone: user?.phone || null,
      email: user?.email || null,
      employer: user?.employer || null,
      payrollNumber: user?.payrollNumber || null,
    },
    applicant: {
      id: member?.id || loan.memberId,
      memberId: loan.memberId,
      memberNumber: member?.memberNumber || null,
      fullName: applicantName,
      email: user?.email || null,
      phone: user?.phone || null,
    },
    type: loan.type,
    loanType: loan.type,
    principal: loan.amount,
    amount: loan.amount,
    requestedAmount: loan.amount,
    principalBalance: Number(loan.principalBalance ?? loan.amount ?? 0),
    accruedInterest: Number(loan.accruedInterest || 0),
    balance: Number(loan.principalBalance ?? loan.amount ?? 0) + Number(loan.accruedInterest || 0),
    paid: Number(loan.paid ?? loan.dataValues?.paid ?? 0),
    repaid: Number(loan.paid ?? loan.dataValues?.paid ?? 0),
    reason: loan.reason || null,
    duration: loan.duration,
    interest: loan.interestRate,
    interestRate: loan.interestRate,
    interestGenerated: scheduledReducingBalanceInterest(amount, interestRate, duration),
    status: loan.type === 'EMERGENCY' && loan.status === 'APPROVED' ? 'AUTO_APPROVED_EMERGENCY' : loan.status,
    autoApproved: loan.type === 'EMERGENCY' && loan.status === 'APPROVED',
    auditTimestamp: loan.decidedAt,
    nextPaymentDueAt: loan.nextPaymentDueAt,
    financeStatus,
    rejectionReason: loan.rejectionReason,
    decidedAt: loan.decidedAt,
    approvedAt: loan.status === 'APPROVED' ? loan.decidedAt || loan.updatedAt : null,
    disbursedDate: ['ACTIVE', 'DISBURSED'].includes(String(loan.status || '').toUpperCase()) ? loan.updatedAt : null,
    createdAt: loan.createdAt,
    updatedAt: loan.updatedAt,
    guarantors: loan.Guarantors || [],
  };
};

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
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 500);
  const offset = (page - 1) * limit;
  const where = { status: 'SUCCESS' };
  if (req.query.type) {
    where.type = req.query.type;
  }
  if (req.query.status && String(req.query.status).toUpperCase() === 'SUCCESS') {
    where.status = 'SUCCESS';
  }
  const [transactionResult, members, transferResult, loanTransactions, loans] = await Promise.all([
    db.Transaction.findAndCountAll({ where, order: [['createdAt', 'DESC']], limit: page * limit }),
    db.Member.findAll({ include: [{ model: db.User, attributes: ['name', 'firstName', 'lastName'] }] }),
    db.ShareCapitalTransfer.findAndCountAll({
      where: { status: 'SUCCESS' },
      include: [
        { model: db.Member, as: 'sender', attributes: ['memberNumber'] },
        { model: db.Member, as: 'recipient', attributes: ['memberNumber'] },
      ], order: [['createdAt', 'DESC']], limit: page * limit,
    }),
    db.LoanTransaction.findAll({ order: [['createdAt', 'DESC']], limit: page * limit }),
    db.Loan.findAll({ attributes: ['id', 'type'] }),
  ]);
  const memberMap = new Map(members.map((member) => [member.id, member]));
  const loanMap = new Map(loans.map((loan) => [loan.id, loan]));
  const repaymentMap = new Map(loanTransactions.map((entry) => [entry.ledgerTransactionId, entry]));
  const formatted = transactionResult.rows.map((transaction) => {
    const member = memberMap.get(transaction.memberId);
    const baseRow = formatTransaction(transaction, member, member?.User);
    const loanType = loanMap.get(transaction.loanId)?.type || null;
    const row = loanType && ['LOAN_REPAYMENT', 'LOAN_DISBURSEMENT'].includes(baseRow.category)
      ? { ...baseRow, loanType, category: `${loanType}_${baseRow.category}` }
      : baseRow;
    const repayment = repaymentMap.get(transaction.id);
    return repayment ? { ...row, transactionType: repayment.transactionType,
      principalPaid: Number(repayment.principalPaid), interestPaid: Number(repayment.interestPaid),
      remainingPrincipal: Number(repayment.remainingPrincipal), accruedDays: repayment.accruedDays } : row;
  });
  formatted.push(...transferResult.rows.map((transfer) => ({
    id: transfer.id,
    type: 'SHARE_CAPITAL_TRANSFER',
    category: transfer.transferType === 'OPT_OUT' ? 'OPT_OUT_SHARE_TRANSFER' : 'SHARE_CAPITAL_TRANSFER',
    destination: 'Member share capital / SACCO revenue',
    amount: Number(transfer.grossAmount),
    feeAmount: Number(transfer.feeAmount),
    netAmount: Number(transfer.netAmount),
    description: `${transfer.sender?.memberNumber} to ${transfer.recipient?.memberNumber} (5% fee: KES ${Number(transfer.feeAmount).toFixed(2)})`,
    createdAt: transfer.createdAt,
    createdAtEAT: formatEAT(transfer.createdAt),
    status: transfer.status,
    reference: transfer.reference,
    memberNumber: transfer.sender?.memberNumber,
    recipientMemberNumber: transfer.recipient?.memberNumber,
  })));
  formatted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const total = transactionResult.count + transferResult.count;
  return ResponseHandler.paginated(res, formatted.slice(offset, offset + limit), {
    page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)),
  }, 'Transactions retrieved successfully');
});

const createTransaction = asyncHandler(async (req, res) => {
  if (!req.body.amount || !req.body.type) {
    throw new ValidationError('Amount and type are required');
  }
  if (String(req.body.type || '').toUpperCase() === 'LOAN_REPAYMENT') {
    if (!req.body.loanId) throw new ValidationError('loanId is required for loan repayments');
    const result = await postManualRepayment({
      loanId: req.body.loanId,
      memberId: req.body.memberId || null,
      amount: req.body.amount,
      reference: req.body.reference,
      evidence: req.body.description || req.body.evidence || null,
      postedById: req.user.id,
      method: String(req.body.method || 'MANUAL').toUpperCase(),
    });
    return ResponseHandler.created(res, {
      id: result.ledger.id,
      type: result.ledger.type,
      amount: Number(result.ledger.amount),
      status: result.ledger.status,
      reference: result.ledger.reference,
      principalPaid: Number(result.repayment.principalPaid),
      interestPaid: Number(result.repayment.interestPaid),
      remainingPrincipal: Number(result.repayment.remainingPrincipal),
    }, 'Loan repayment posted and allocated successfully');
  }
  const transaction = await db.Transaction.create({
    memberId: req.body.memberId || null,
    loanId: req.body.loanId || null,
    type: req.body.type,
    amount: req.body.amount,
    method: req.body.method || 'MANUAL',
    status: req.body.status || 'SUCCESS',
    reference: req.body.reference || null,
    description: req.body.description || null,
    paymentCategory: req.body.paymentCategory || null,
    kcbEndpoint: req.body.kcbEndpoint || null,
    internalReference: req.body.internalReference || null,
    promptChannel: req.body.promptChannel || null,
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
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    internalReference: transaction.internalReference,
    promptChannel: transaction.promptChannel,
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
  if (String(transaction.type || '').toUpperCase() === 'LOAN_REPAYMENT') {
    const result = await voidRepayment({
      ledgerTransactionId: transaction.id,
      reason,
      voidedById: req.user.id,
    });
    return ResponseHandler.success(res, {
      id: result.ledger.id,
      status: result.ledger.status,
      reference: result.ledger.reference,
    }, 'Loan repayment reversed and voided successfully', 200);
  }
  await transaction.update({ status: 'FAILED', reference: reason || transaction.reference });
  return ResponseHandler.success(res, {
    id: transaction.id,
    status: transaction.status,
    reference: transaction.reference,
  }, 'Transaction voided successfully', 200);
});

const verifyTransaction = asyncHandler(async (req, res) => {
  const transaction = await db.Transaction.findByPk(req.params.transactionId);
  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }
  if (String(transaction.type || '').toUpperCase() === 'LOAN_REPAYMENT') {
    throw new ValidationError('Loan repayments must be posted through the repayment allocation engine, not raw verification');
  }

  await transaction.update({ status: 'SUCCESS' });
  return ResponseHandler.success(res, {
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    internalReference: transaction.internalReference,
    promptChannel: transaction.promptChannel,
    memberId: transaction.memberId,
    loanId: transaction.loanId,
  }, 'Transaction verified successfully', 200);
});

const getAllLoans = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  const loans = await db.Loan.findAll({
    where,
    include: [db.Guarantor, { model: db.Member, include: [{ model: db.User, attributes: { exclude: ['password', 'otp', 'refreshToken'] } }] }],
    order: [['createdAt', 'DESC']],
  });
  const loanIds = loans.map((loan) => loan.id);
  const repayments = loanIds.length
    ? await db.Transaction.findAll({
      where: {
        loanId: { [db.Sequelize.Op.in]: loanIds },
        type: 'LOAN_REPAYMENT',
        status: 'SUCCESS',
      },
      attributes: ['loanId', 'amount'],
    })
    : [];
  const repaymentsByLoan = repayments.reduce((totals, repayment) => {
    totals.set(
      repayment.loanId,
      (totals.get(repayment.loanId) || 0) + Number(repayment.amount || 0),
    );
    return totals;
  }, new Map());
  loans.forEach((loan) => {
    loan.dataValues.paid = repaymentsByLoan.get(loan.id) || 0;
  });
  const formatted = loans.map(formatLoan);
  return ResponseHandler.success(res, formatted, 'Loans retrieved successfully', 200);
});

const getLoanById = asyncHandler(async (req, res) => {
  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  return ResponseHandler.success(res, formatLoan(loan), 'Loan retrieved successfully', 200);
});

const approveLoan = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const loan = await loanService.updateLoanStatus(req.params.loanId, 'APPROVED', {
    approvedById: req.user.id,
    approvedAmount: body.approvedAmount,
    interestRate: body.interestRate,
    duration: body.duration,
  });
  if (!loan) throw new NotFoundError('Loan not found');
  return ResponseHandler.success(res, formatLoan(loan), 'Loan approved successfully', 200);
});

const rejectLoan = asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    throw new ValidationError('Rejection reason is required');
  }
  const loan = await loanService.updateLoanStatus(req.params.loanId, 'REJECTED', {
    approvedById: req.user.id,
    reason: req.body.reason,
  });
  if (!loan) throw new NotFoundError('Loan not found');
  return ResponseHandler.success(res, formatLoan(loan), 'Loan rejected successfully', 200);
});

const disburseLoan = asyncHandler(async (req, res) => {
  const result = await loanService.disburseLoan(req.params.loanId, { disbursedById: req.user.id });
  if (!result) throw new NotFoundError('Loan not found');
  return ResponseHandler.success(res, {
    loan: LoanDTO.basic(result.loan, req.user),
    walletTransactionId: result.walletTransactionId,
  }, 'Loan disbursed successfully', 200);
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
  const [memberDividends, declaredDividends] = await Promise.all([
    db.MemberDividend.findAll({
      include: [
        { model: db.FinancialYearReport, as: 'financialYear', attributes: ['id', 'year'] },
        { model: db.User, attributes: ['id', 'name', 'email'], include: [{ model: db.Member, attributes: ['id', 'memberNumber'] }] },
      ],
      order: [[{ model: db.FinancialYearReport, as: 'financialYear' }, 'year', 'DESC'], ['updatedAt', 'DESC']],
      limit: 2000,
    }),
    db.Dividend.findAll({ order: [['createdAt', 'DESC']] }),
  ]);
  return ResponseHandler.success(res, [...memberDividends.map(formatMemberDividend), ...declaredDividends.map(formatDividend)], 'Dividends retrieved successfully', 200);
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

  const member = await db.Member.findByPk(deduction.memberId);
  return ResponseHandler.success(res, formatDeduction(deduction, member), 'Deduction updated successfully', 200);
});

const getAllMembers = asyncHandler(async (req, res) => {
  const [members, transactions, loans, shareAccounts] = await Promise.all([
    db.Member.findAll({
      include: [{ model: db.User, attributes: ['name', 'firstName', 'lastName', 'email', 'phone', 'employer', 'monthlyIncome', 'staffId', 'isWhitelisted', 'employerContribution'] }],
      order: [['createdAt', 'DESC']],
    }),
    db.Transaction.findAll({ where: { status: 'SUCCESS' } }),
    db.Loan.findAll(),
    db.ShareAccount.findAll(),
  ]);

  const formatted = members.map((member) => {
    const user = member.User || {};
    const name = user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || member.memberNumber || member.id;
    const memberTransactions = transactions.filter((transaction) => transaction.memberId === member.id);
    const memberLoans = loans.filter((loan) => loan.memberId === member.id);
    const shareAccount = shareAccounts.find((account) => account.memberId === member.id);
    const shareContributions = memberTransactions
      .filter((transaction) => classifyTransaction(transaction).category === 'SHARE_CAPITAL')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const savingsDeposits = memberTransactions
      .filter((transaction) => classifyTransaction(transaction).category === 'SAVINGS')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const withdrawals = memberTransactions
      .filter((transaction) => classifyTransaction(transaction).category === 'WITHDRAWAL')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const shareCapital = Math.max(
      shareContributions,
      Number((shareAccount?.shares || 0) * (shareAccount?.shareValue || 0)),
    );
    const outstandingLoans = memberLoans
      .filter((loan) => !['COMPLETED', 'REJECTED'].includes(String(loan.status || '').toUpperCase()))
      .reduce((sum, loan) => sum + Number(loan.principalBalance ?? loan.amount ?? 0) + Number(loan.accruedInterest || 0), 0);
    return {
      id: member.id,
      memberNumber: member.memberNumber || null,
      memberId: member.id,
      userId: member.userId,
      name,
      phone: user.phone,
      email: user.email,
      company: user.employer || null,
      salary: Number(user.monthlyIncome || 0),
      deduction: 0,
      staffId: user.staffId || null,
      isWhitelisted: Boolean(user.isWhitelisted),
      savings: Math.max(Number(member.savings || 0), Math.max(savingsDeposits - withdrawals, 0)),
      loans: outstandingLoans,
      shares: Math.max(Number(member.shareCapital || 0), shareCapital),
      loanRepayment: Number(member.loanRepayment || 0),
      interest: Number(member.interest || 0),
      employerContribution: Number(member.employerContribution || user.employerContribution || 0),
      shareCapitalBalance: Math.max(MINIMUM_SHARE_CAPITAL - shareCapital, 0),
      risk: memberLoans.some((loan) => ['OVERDUE', 'DEFAULTED', 'WRITTEN_OFF'].includes(String(loan.status || '').toUpperCase())) ? 'High' : 'Low',
      status: member.isVerified ? 'Active' : 'Pending',
      createdAt: member.createdAt,
    };
  });

  return ResponseHandler.success(res, formatted, 'Members retrieved successfully', 200);
});

const getMemberFinancialProfile = asyncHandler(async (req, res) => {
  const identifier = String(req.params.memberId || '').trim();
  let member = await db.Member.findByPk(identifier);
  if (!member) member = await db.Member.findOne({ where: { memberNumber: identifier.toUpperCase() } });
  if (!member) throw new NotFoundError('Member not found');

  const [user, transactions, loans, shareAccount] = await Promise.all([
    db.User.findByPk(member.userId, { attributes: { exclude: ['password', 'otp', 'refreshToken'] } }),
    db.Transaction.findAll({ where: { memberId: member.id }, order: [['createdAt', 'DESC']] }),
    db.Loan.findAll({ where: { memberId: member.id }, order: [['createdAt', 'DESC']] }),
    db.ShareAccount.findOne({ where: { memberId: member.id } }),
  ]);
  const formattedTransactions = transactions.map((transaction) => formatTransaction(transaction, member, user));
  const successful = formattedTransactions.filter((transaction) => transaction.status === 'SUCCESS');
  const shareHistory = successful.filter((transaction) => transaction.category === 'SHARE_CAPITAL');
  const shareCapitalFromTransactions = shareHistory.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const shareCapital = Math.max(
    shareCapitalFromTransactions,
    Number((shareAccount?.shares || 0) * (shareAccount?.shareValue || 0)),
  );
  const repaymentHistory = formattedTransactions.filter((transaction) => transaction.category === 'LOAN_REPAYMENT');
  const loanHistory = loans.map((loan) => {
    const repayments = repaymentHistory.filter((transaction) => !transaction.loanId || transaction.loanId === loan.id);
    const repaid = repayments.filter((transaction) => transaction.status === 'SUCCESS')
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    return {
      id: loan.id,
      type: loan.type,
      amount: loan.amount,
      principal: loan.amount,
      interestRate: loan.interestRate,
      duration: loan.duration,
      status: loan.status,
      approvalStage: loan.approvalStage,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt,
      repaid,
      balance: Number(loan.principalBalance ?? loan.amount ?? 0) + Number(loan.accruedInterest || 0),
    };
  });
  const defaultingHistory = loanHistory.filter((loan) =>
    ['OVERDUE', 'DEFAULTED', 'WRITTEN_OFF'].includes(String(loan.status || '').toUpperCase()));

  return ResponseHandler.success(res, {
    member: {
      id: member.id,
      memberNumber: member.memberNumber,
      status: member.status || (member.isVerified ? 'ACTIVE' : 'PENDING'),
      dateJoined: member.dateJoined || member.createdAt,
      nationalId: member.nationalId,
      staffId: user?.staffId || null,
      isWhitelisted: Boolean(user?.isWhitelisted),
      company: user?.employer || null,
      employerContribution: Number(member.employerContribution || user?.employerContribution || 0),
      user,
    },
    summary: {
      totalTransactions: formattedTransactions.length,
      savings: Math.max(
        successful
          .filter((transaction) => transaction.category === 'SAVINGS')
          .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0)
        - successful
          .filter((transaction) => transaction.category === 'WITHDRAWAL')
          .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0),
        0,
      ),
      shareCapital,
      employerContribution: Number(member.employerContribution || user?.employerContribution || 0),
      minimumShareCapital: MINIMUM_SHARE_CAPITAL,
      shareCapitalBalance: Math.max(MINIMUM_SHARE_CAPITAL - shareCapital, 0),
      outstandingLoans: loanHistory
        .filter((loan) => !['COMPLETED', 'REJECTED'].includes(String(loan.status || '').toUpperCase()))
        .reduce((sum, loan) => sum + Number(loan.balance || 0), 0),
      totalRepaid: repaymentHistory
        .filter((transaction) => transaction.status === 'SUCCESS')
        .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0),
      defaults: defaultingHistory.length,
    },
    transactions: formattedTransactions,
    loans: loanHistory,
    repayments: repaymentHistory,
    defaults: defaultingHistory,
    shares: {
      account: shareAccount ? formatShareAccount(shareAccount) : null,
      contributionHistory: shareHistory,
      total: shareCapital,
      minimumRequired: MINIMUM_SHARE_CAPITAL,
      balanceRemaining: Math.max(MINIMUM_SHARE_CAPITAL - shareCapital, 0),
      minimumAttained: shareCapital >= MINIMUM_SHARE_CAPITAL,
    },
  }, 'Member financial profile retrieved successfully', 200);
});

const getAllCompanies = asyncHandler(async (req, res) => {
  const users = await db.User.findAll({
    where: { employer: { [db.Sequelize.Op.ne]: null } },
    attributes: ['employer', 'monthlyIncome'],
  });

  const companyMap = new Map();
  users.forEach((user) => {
    const name = String(user.employer || '').trim();
    if (!name) return;
    const current = companyMap.get(name) || { id: name, name, employees: 0, totalDeductions: 0, status: 'Active' };
    current.employees += 1;
    current.totalDeductions += Number(user.monthlyIncome || 0) * 0.1;
    companyMap.set(name, current);
  });

  return ResponseHandler.success(res, Array.from(companyMap.values()), 'Companies retrieved successfully', 200);
});

const getFinancialReports = asyncHandler(async (req, res) => {
  const [transactions, groupTransactions, loans, dividends, transfers, loanTransactions, members, membershipApplications] = await Promise.all([
    db.Transaction.findAll({ where: { status: 'SUCCESS' }, order: [['createdAt', 'ASC']] }),
    db.GroupTransaction.findAll({ where: { status: 'SUCCESS' }, order: [['createdAt', 'ASC']] }),
    db.Loan.findAll({ order: [['createdAt', 'ASC']] }),
    db.Dividend.findAll({ order: [['createdAt', 'ASC']] }),
    db.ShareCapitalTransfer.findAll({ where: { status: 'SUCCESS' } }),
    db.LoanTransaction.findAll({ attributes: ['id', 'loanId', 'memberId', 'ledgerTransactionId', 'amount', 'principalPaid', 'interestPaid', 'metadata', 'createdAt'] }),
    db.Member.findAll({ attributes: ['id', 'userId', 'applicationId', 'memberNumber'], include: [{ model: db.User, attributes: ['name', 'firstName', 'lastName', 'email'] }] }),
    db.MembershipApplication.findAll({ attributes: ['id', 'name', 'email'] }),
  ]);

  const repaymentsByLoan = transactions.reduce((map, transaction) => {
    if (transaction.type === 'LOAN_REPAYMENT' && transaction.status === 'SUCCESS' && transaction.loanId) {
      map.set(transaction.loanId, (map.get(transaction.loanId) || 0) + Number(transaction.amount || 0));
    }
    return map;
  }, new Map());
  const calculatedLoanInterest = loans.reduce((sum, loan) => {
    const principal = Number(loan.amount || 0);
    const scheduledInterest = scheduledReducingBalanceInterest(principal, loan.interestRate, loan.duration);
    const totalDue = principal + scheduledInterest;
    const repaid = Math.min(repaymentsByLoan.get(loan.id) || 0, totalDue);
    const realizedInterest = totalDue > 0 ? repaid * (scheduledInterest / totalDue) : 0;
    return sum + realizedInterest;
  }, 0);
  const allocatedLoanInterest = loanTransactions.reduce((sum, entry) => sum + Number(entry.interestPaid || 0), 0);
  const loanRepaymentInterest = loanTransactions.length ? allocatedLoanInterest : calculatedLoanInterest;
  const shareCapitalTransferFees = transfers.reduce((sum, transfer) => sum + Number(transfer.feeAmount || 0), 0);
  const loanMap = new Map(loans.map((loan) => [loan.id, loan]));
  const products = ['EMERGENCY', 'EDUCATION', 'DEVELOPMENT', 'WELFARE'];
  const byProduct = Object.fromEntries(products.map((product) => [product, { repayments: 0, disbursements: 0 }]));
  const flowTotals = { deposits: 0, shareCapitalDeposits: 0, savingsDeposits: 0, withdrawals: 0, repayments: 0, disbursements: 0 };
  const applicationMap = new Map(membershipApplications.map((application) => [application.id, application]));
  const memberMap = new Map(members.map((member) => [member.id, {
    memberId: member.id, memberNumber: member.memberNumber,
    memberName: member.User?.name
      || [member.User?.firstName, member.User?.lastName].filter(Boolean).join(' ')
      || applicationMap.get(member.applicationId)?.name
      || member.User?.email
      || applicationMap.get(member.applicationId)?.email
      || 'Unknown member',
  }]));
  const ledgerMap = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const loanInterestBreakdown = loanTransactions
    .filter((entry) => Number(entry.interestPaid || 0) > 0)
    .map((entry) => {
      const identity = memberMap.get(entry.memberId) || { memberId: entry.memberId, memberNumber: 'Unknown', memberName: 'Unknown member' };
      const ledger = ledgerMap.get(entry.ledgerTransactionId);
      const occurredAt = ledger?.createdAt || entry.createdAt;
      return {
        id: entry.id,
        ...identity,
        reference: entry.metadata?.mpesa_receipt_number || ledger?.reference || entry.ledgerTransactionId,
        sourceAmount: Number(entry.amount || ledger?.amount || 0),
        interestAmount: Number(entry.interestPaid || 0),
        principalAmount: Number(entry.principalPaid || 0),
        occurredAt,
        occurredAtEAT: formatEAT(occurredAt),
      };
    })
    .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
  const shareCapitalInterestBreakdown = transfers
    .filter((transfer) => Number(transfer.feeAmount || 0) > 0)
    .map((transfer) => {
      const identity = memberMap.get(transfer.senderMemberId) || { memberId: transfer.senderMemberId, memberNumber: 'Unknown', memberName: 'Unknown member' };
      return {
        id: transfer.id,
        ...identity,
        reference: transfer.metadata?.mpesa_receipt_number || transfer.metadata?.mpesaReceiptNumber || transfer.reference,
        sourceAmount: Number(transfer.grossAmount || 0),
        interestAmount: Number(transfer.feeAmount || 0),
        occurredAt: transfer.createdAt,
        occurredAtEAT: formatEAT(transfer.createdAt),
      };
    })
    .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
  const effectiveLoanInterestBreakdown = loanInterestBreakdown.length ? loanInterestBreakdown : transactions
    .filter((transaction) => transaction.type === 'LOAN_REPAYMENT' && transaction.loanId)
    .map((transaction) => {
      const identity = memberMap.get(transaction.memberId) || { memberId: transaction.memberId, memberNumber: 'Unknown', memberName: 'Unknown member' };
      const loan = loanMap.get(transaction.loanId);
      const principal = Number(loan?.amount || 0);
      const scheduledInterest = scheduledReducingBalanceInterest(principal, loan?.interestRate, loan?.duration);
      const interestAmount = principal + scheduledInterest > 0 ? Number(transaction.amount || 0) * scheduledInterest / (principal + scheduledInterest) : 0;
      return {
        id: transaction.id, ...identity, reference: transaction.reference,
        sourceAmount: Number(transaction.amount || 0), interestAmount: Math.round(interestAmount * 100) / 100,
        occurredAt: transaction.createdAt, occurredAtEAT: formatEAT(transaction.createdAt),
      };
    })
    .filter((row) => row.interestAmount > 0)
    .sort((left, right) => new Date(right.occurredAt) - new Date(left.occurredAt));
  const breakdownKeys = [...Object.keys(flowTotals), ...products.flatMap((product) => [`repayments_${product}`, `disbursements_${product}`])];
  const breakdownMaps = Object.fromEntries(breakdownKeys.map((key) => [key, new Map()]));
  const addMemberAmount = (key, memberId, amount) => {
    const identity = memberMap.get(memberId) || { memberId, memberNumber: 'Unknown', memberName: 'Unknown member' };
    const current = breakdownMaps[key].get(memberId) || { ...identity, amount: 0 };
    current.amount += amount; breakdownMaps[key].set(memberId, current);
  };
  const timeSeries = { daily: {}, monthly: {}, yearly: {} };
  const ensurePeriod = (bucket, key) => (bucket[key] ||= { label: key, deposits: 0, withdrawals: 0, repayments: 0, disbursements: 0, count: 0 });
  const reportTransactions = [
    ...transactions,
    ...groupTransactions.map((transaction) => ({
      ...transaction.toJSON(),
      paymentCategory: 'group_loan',
      description: `Group ${transaction.type}`,
    })),
  ];
  reportTransactions.forEach((transaction) => {
    const amount = Number(transaction.amount || 0); const type = String(transaction.type || '').toUpperCase();
    const classification = classifyTransaction(transaction); const createdAt = new Date(transaction.createdAt);
    const eatDate = new Date(createdAt.getTime() + (3 * 60 * 60 * 1000));
    const day = eatDate.toISOString().slice(0, 10); const month = day.slice(0, 7); const year = day.slice(0, 4);
    let metric = null;
    if (type === 'DEPOSIT') { metric = 'deposits'; flowTotals.deposits += amount; addMemberAmount('deposits', transaction.memberId, amount);
      if (classification.category === 'SHARE_CAPITAL') { flowTotals.shareCapitalDeposits += amount; addMemberAmount('shareCapitalDeposits', transaction.memberId, amount); }
      else { flowTotals.savingsDeposits += amount; addMemberAmount('savingsDeposits', transaction.memberId, amount); }
    } else if (type === 'WITHDRAWAL') { metric = 'withdrawals'; flowTotals.withdrawals += amount; addMemberAmount('withdrawals', transaction.memberId, amount);
    } else if (type === 'LOAN_REPAYMENT') { metric = 'repayments'; flowTotals.repayments += amount; addMemberAmount('repayments', transaction.memberId, amount);
      const product = String(loanMap.get(transaction.loanId)?.type || '').toUpperCase(); if (byProduct[product]) { byProduct[product].repayments += amount; addMemberAmount(`repayments_${product}`, transaction.memberId, amount); }
    } else if (type === 'LOAN_DISBURSEMENT') { metric = 'disbursements'; flowTotals.disbursements += amount; addMemberAmount('disbursements', transaction.memberId, amount);
      const product = String(loanMap.get(transaction.loanId)?.type || '').toUpperCase(); if (byProduct[product]) { byProduct[product].disbursements += amount; addMemberAmount(`disbursements_${product}`, transaction.memberId, amount); }
    }
    [['daily', day], ['monthly', month], ['yearly', year]].forEach(([period, key]) => {
      const row = ensurePeriod(timeSeries[period], key); row.count += 1; if (metric) row[metric] += amount;
    });
  });
  const serializedSeries = Object.fromEntries(Object.entries(timeSeries).map(([period, rows]) => [period, Object.values(rows).sort((a, b) => a.label.localeCompare(b.label))]));
  const memberBreakdowns = Object.fromEntries(Object.entries(breakdownMaps).map(([key, rows]) => [key,
    Array.from(rows.values()).sort((a, b) => b.amount - a.amount).map((row) => ({ ...row, amount: Math.round(row.amount * 100) / 100 })),
  ]));

  return ResponseHandler.success(res, {
    totals: {
      transactions: reportTransactions.length + transfers.length,
      loans: loans.length,
      dividends: dividends.length,
      transactionAmount: reportTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0) + transfers.reduce((sum, transfer) => sum + Number(transfer.grossAmount || 0), 0),
      loanPrincipal: loans.reduce((sum, loan) => sum + Number(loan.amount || 0), 0),
      dividendsDeclared: dividends.reduce((sum, dividend) => sum + Number(dividend.amount || 0), 0),
      interests: {
        total: loanRepaymentInterest + shareCapitalTransferFees,
        loanRepaymentInterest,
        shareCapitalTransferFees,
      },
      ...flowTotals,
    },
    byProduct,
    memberBreakdowns,
    interestBreakdowns: {
      loanRepaymentInterest: effectiveLoanInterestBreakdown,
      shareCapitalTransferFees: shareCapitalInterestBreakdown,
    },
    timeSeries: serializedSeries,
    generatedAt: new Date(),
    generatedAtEAT: formatEAT(new Date()),
  }, 'Financial reports retrieved successfully', 200);
});

const getActiveGroupLoans = asyncHandler(async (req, res) => {
  const groups = await db.BorrowingGroup.findAll({
    include: [
      { model: db.GroupLoan, as: 'loans', required: true, where: { status: 'ACTIVE' } },
      { model: db.GroupTransaction, as: 'transactions', required: false },
      { model: db.GroupLoanProposal, as: 'proposals', required: false, where: { status: 'DISBURSED' }, include: [{ model: db.GroupLoanAllocation, as: 'allocations', include: [{ model: db.Member, as: 'member', attributes: ['id', 'memberNumber'], include: [{ model: db.User, attributes: ['name'] }] }] }] },
    ],
    order: [['updatedAt', 'DESC']],
  });
  const items = groups.flatMap((group) => group.loans.map((loan) => {
    const proposal = group.proposals.find((item) => item.id === loan.proposalId);
    const repayments = group.transactions.filter((item) => item.loanId === loan.id && item.type === 'LOAN_REPAYMENT' && item.status === 'SUCCESS');
    const amountPaid = repayments.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return { id: loan.id, groupId: group.id, groupName: group.name, proposalId: loan.proposalId, disbursedAmount: Number(loan.amount), totalDue: Number(loan.totalDue), amountPaid, outstandingBalance: Number(loan.balance), progressPercentage: Number(loan.totalDue) > 0 ? Math.min(amountPaid / Number(loan.totalDue) * 100, 100) : 0, status: loan.status,
      members: (proposal?.allocations || []).map((allocation) => { const paid = repayments.filter((row) => row.memberId === allocation.memberId).reduce((sum, row) => sum + Number(row.amount || 0), 0); const due = Number(allocation.principalAmount) + Number(allocation.interestAmount); return { memberId: allocation.memberId, memberNumber: allocation.member?.memberNumber, name: allocation.member?.User?.name || allocation.member?.memberNumber, totalPayable: due, amountPaid: paid, outstandingBalance: Math.max(due - paid, 0), repaymentStatus: allocation.repaymentStatus }; }),
    };
  }));
  return ResponseHandler.success(res, { items, summary: { activeGroups: groups.length, activeLoans: items.length, totalDisbursed: items.reduce((sum, item) => sum + item.disbursedAmount, 0), totalPaid: items.reduce((sum, item) => sum + item.amountPaid, 0), totalOutstanding: items.reduce((sum, item) => sum + item.outstandingBalance, 0) } }, 'Active group loans retrieved successfully');
});

const getGroupBorrowingOverview = asyncHandler(async (req, res) => {
  const groups = await db.BorrowingGroup.findAll({
    include: [
      { model: db.GroupMembership, as: 'memberships', include: [{ model: db.Member, as: 'member', attributes: ['id', 'memberNumber'], include: [{ model: db.User, attributes: ['name', 'email', 'phone'] }] }] },
      { model: db.GroupLoan, as: 'loans' },
      { model: db.GroupTransaction, as: 'transactions' },
      { model: db.GroupLoanProposal, as: 'proposals', include: [{ model: db.GroupLoanAllocation, as: 'allocations' }] },
      { model: db.GroupGovernanceAction, as: 'governanceActions', include: [{ model: db.Member, as: 'proposedBy', attributes: ['id', 'memberNumber'], include: [{ model: db.User, attributes: ['name'] }] }] },
    ],
    order: [['updatedAt', 'DESC']],
  });
  const items = groups.map((groupModel) => {
    const group = groupModel.toJSON();
    const repayments = group.transactions.filter((row) => row.type === 'LOAN_REPAYMENT' && row.status === 'SUCCESS');
    const loans = group.loans.map((loan) => {
      const proposal = group.proposals.find((row) => row.id === loan.proposalId);
      const loanRepayments = repayments.filter((row) => row.loanId === loan.id);
      const amountPaid = loanRepayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const scheduledInterest = proposal ? proposal.allocations.reduce((sum, row) => sum + Number(row.interestAmount || 0), 0) : Math.max(Number(loan.totalDue || 0) - Number(loan.amount || 0), 0);
      const totalDue = Number(loan.totalDue || 0);
      const interestEarned = totalDue > 0 ? Math.min(amountPaid, totalDue) * scheduledInterest / totalDue : 0;
      return { ...loan, amount: Number(loan.amount), totalDue, balance: Number(loan.balance), amountPaid, scheduledInterest, interestEarned, repaymentProgress: totalDue > 0 ? Math.min(amountPaid / totalDue * 100, 100) : 0 };
    });
    return {
      id: group.id, name: group.name, description: group.description, status: group.status, creatorMemberId: group.creatorMemberId, createdAt: group.createdAt,
      governanceSettings: group.governanceSettings || {},
      governanceActions: (group.governanceActions || []).map((action) => ({ id: action.id, title: action.title, actionType: action.actionType, payload: action.payload || {}, votes: action.votes || {}, status: action.status, executedAt: action.executedAt, createdAt: action.createdAt, proposedBy: action.proposedBy?.User?.name || action.proposedBy?.memberNumber || null })),
      members: group.memberships.map((membership) => ({ membershipId: membership.id, memberId: membership.memberId, memberNumber: membership.member?.memberNumber, name: membership.member?.User?.name || membership.member?.memberNumber, email: membership.member?.User?.email, phone: membership.member?.User?.phone, role: membership.role, status: membership.status, joinedAt: membership.respondedAt || membership.createdAt })),
      loans,
      proposals: group.proposals.map((proposal) => ({ ...proposal, totalAmount: Number(proposal.totalAmount), interestRate: Number(proposal.interestRate), scheduledInterest: proposal.allocations.reduce((sum, row) => sum + Number(row.interestAmount || 0), 0), allocationCount: proposal.allocations.length })),
      transactions: [...group.transactions].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)),
      totals: { borrowed: loans.reduce((sum, loan) => sum + loan.amount, 0), repaid: loans.reduce((sum, loan) => sum + loan.amountPaid, 0), outstanding: loans.reduce((sum, loan) => sum + loan.balance, 0), scheduledInterest: loans.reduce((sum, loan) => sum + loan.scheduledInterest, 0), interestEarned: loans.reduce((sum, loan) => sum + loan.interestEarned, 0) },
    };
  });
  return ResponseHandler.success(res, { items, summary: { groups: items.length, activeGroups: items.filter((group) => group.loans.some((loan) => loan.status === 'ACTIVE')).length, totalBorrowed: items.reduce((sum, group) => sum + group.totals.borrowed, 0), totalOutstanding: items.reduce((sum, group) => sum + group.totals.outstanding, 0), totalInterestEarned: items.reduce((sum, group) => sum + group.totals.interestEarned, 0) } }, 'Group borrowing overview retrieved successfully');
});

const dismantleBorrowingGroup = asyncHandler(async (req, res) => {
  if (String(req.user?.role || '').toUpperCase() !== 'FINANCE') throw new ForbiddenError('Only Finance can dismantle a borrowing group');
  const group = await db.BorrowingGroup.findByPk(req.params.groupId, {
    include: [
      { model: db.GroupMembership, as: 'memberships', include: [{ model: db.Member, as: 'member', attributes: ['id', 'userId', 'memberNumber'] }] },
      { model: db.GroupLoan, as: 'loans' },
      { model: db.GroupLoanProposal, as: 'proposals' },
    ],
  });
  if (!group) throw new NotFoundError('Borrowing group not found');
  if (group.status === 'CLOSED') return ResponseHandler.success(res, { groupId: group.id, status: 'CLOSED', replayed: true }, 'Group is already dismantled');
  if (group.loans?.length || group.proposals?.some((proposal) => ['APPROVED', 'DISBURSED'].includes(proposal.status))) {
    throw new ValidationError('This group cannot be dismantled after a loan has been approved or disbursed');
  }
  const memberships = group.memberships || [];
  await db.sequelize.transaction(async (transaction) => {
    await db.GroupLoanProposal.update({ status: 'REJECTED' }, { where: { groupId: group.id, status: { [db.Sequelize.Op.in]: ['DRAFT', 'PENDING_MEMBER_APPROVAL'] } }, transaction });
    await db.GroupMembership.update({ status: 'REMOVED', respondedAt: new Date() }, { where: { groupId: group.id, status: { [db.Sequelize.Op.in]: ['INVITED', 'ACTIVE'] } }, transaction });
    await group.update({ status: 'CLOSED' }, { transaction });
  });
  const memberUserIds = [...new Set(memberships.map((membership) => membership.member?.userId).filter(Boolean))];
  await Promise.allSettled(memberUserIds.map((userId) => db.Notification.create({
    userId, eventKey: `group-dismantled:${group.id}:${userId}`, title: 'Group dismantled by management', body: `${group.name} was dismantled by management and is no longer active. Any pending loan proposal was cancelled.`, category: 'group', severity: 'warning', actionUrl: '/dashboard/user/notifications', sourceType: 'BorrowingGroup', sourceId: group.id, metadata: { groupId: group.id, groupName: group.name, status: 'CLOSED', reason: 'Dismantled by management' },
  })));
  return ResponseHandler.success(res, { groupId: group.id, status: 'CLOSED', notifiedMembers: memberUserIds.length }, 'Group dismantled and members notified');
});

module.exports = {
  getAllTransactions,
  createTransaction,
  voidTransaction,
  verifyTransaction,
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
  getAllMembers,
  getMemberFinancialProfile,
  getAllCompanies,
  getFinancialReports,
  getActiveGroupLoans,
  getGroupBorrowingOverview,
  dismantleBorrowingGroup,
};
