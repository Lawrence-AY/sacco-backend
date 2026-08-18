const db = require('../../../models');
const notificationService = require('../../notifications/services/notificationService');
const logger = require('../../../shared/utils/logger');
const crypto = require('crypto');

const GUARANTOR_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

const isEmergencyLoan = (type) => String(type || '').toUpperCase() === 'EMERGENCY';
const RESTRICTED_LOAN_STATUSES = ['PENDING', 'PENDING_GUARANTORS', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DISBURSED'];

const addMonths = (value, months) => {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date;
};

const getAvailableGuaranteeSavings = async (memberId, excludeGuarantorId = null) => {
  const [savingsAccount, successfulTransactions, activeGuarantees] = await Promise.all([
    db.SavingsAccount.findOne({ where: { memberId } }),
    db.Transaction.findAll({
      where: {
        memberId,
        status: 'SUCCESS',
      },
    }),
    db.Guarantor.sum('amount', {
      where: {
        memberId,
        ...(excludeGuarantorId ? { id: { [db.Sequelize.Op.ne]: excludeGuarantorId } } : {}),
        status: { [db.Sequelize.Op.in]: ['PENDING', 'ACCEPTED'] },
      },
    }),
  ]);

  const savingsFromTransactions = successfulTransactions.reduce((sum, transaction) => {
    const category = String(
      transaction.paymentCategory ||
      transaction.kcbEndpoint ||
      transaction.description ||
      transaction.type ||
      ''
    ).toLowerCase();
    return category.includes('savings') ? sum + Number(transaction.amount || 0) : sum;
  }, 0);
  const savings = Math.max(Number(savingsAccount?.balance || 0), savingsFromTransactions);
  return Math.max(savings - Number(activeGuarantees || 0), 0);
};

const makeWalletTransactionId = () => {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `TXN-${date}-${suffix}`;
};

const runEmergencyEligibilityChecks = async (memberId) => {
  const member = await db.Member.findByPk(memberId);
  const blockingLoan = await db.Loan.findOne({
    where: {
      memberId,
      status: { [db.Sequelize.Op.in]: ['REJECTED'] },
      type: 'EMERGENCY',
    },
    order: [['updatedAt', 'DESC']],
  });

  return {
    eligible: Boolean(member?.isVerified || member?.status === 'ACTIVE') && !blockingLoan,
    checks: [
      { name: 'Member KYC', passed: Boolean(member?.isVerified || member?.status === 'ACTIVE') },
      { name: 'Emergency loan standing', passed: !blockingLoan },
    ],
  };
};

const finalizeLoanDisbursement = async (loan, transaction) => {
  const amount = Number(loan.amount || 0);
  if (!amount || amount <= 0) return;

  const member = await db.Member.findByPk(loan.memberId, { transaction });
  const walletMemberId = String(member?.memberNumber || loan.memberId).slice(0, 32);
  const [wallet] = await db.Wallet.findOrCreate({
    where: { memberId: walletMemberId },
    defaults: {
      id: `WAL-${walletMemberId}`.slice(0, 32),
      walletId: `WAL-${walletMemberId}`.slice(0, 32),
      memberId: walletMemberId,
    },
    transaction,
  });

  const existingLedger = await db.Transaction.findOne({
    where: {
      loanId: loan.id,
      type: 'LOAN_DISBURSEMENT',
      status: 'SUCCESS',
    },
    transaction,
  });

  if (!existingLedger) {
    await db.Transaction.create({
      memberId: loan.memberId,
      loanId: loan.id,
      type: 'LOAN_DISBURSEMENT',
      amount,
      method: 'MANUAL',
      status: 'SUCCESS',
      reference: `LOAN-${loan.id}`,
      description: `${loan.type || 'Loan'} disbursement`,
      paymentCategory: 'loan_disbursement',
    }, { transaction });
  }

  const existingWalletTx = await db.WalletTransaction.findOne({
    where: {
      externalReference: loan.id,
      type: 'LOAN_DISBURSED',
    },
    transaction,
  });

  if (existingWalletTx) return existingWalletTx;

  const previousWithdrawable = Number(wallet.withdrawableBalance || 0);
  const nextWithdrawable = previousWithdrawable + amount;
  await wallet.update({ withdrawableBalance: nextWithdrawable }, { transaction });

  const txId = makeWalletTransactionId();
  const walletTransaction = await db.WalletTransaction.create({
    id: txId,
    transactionId: txId,
    walletId: wallet.walletId || wallet.id,
    memberId: walletMemberId,
    type: 'LOAN_DISBURSED',
    amount,
    prevDepositedBalance: wallet.depositedBalance,
    newDepositedBalance: wallet.depositedBalance,
    prevWithdrawableBalance: previousWithdrawable,
    newWithdrawableBalance: nextWithdrawable,
    paymentMethod: 'CASH_DESK',
    externalReference: loan.id,
    status: 'VERIFIED',
    complianceStatus: 'PASSED',
    complianceReason: 'Finance-approved loan disbursed to member wallet.',
  }, { transaction });
  return walletTransaction;
};

const getAllLoans = async () => {
  return await db.Loan.findAll({
    include: [db.Guarantor, { model: db.Member, include: [db.User] }],
    order: [['createdAt', 'DESC']],
  });
};

const getLoanById = async (id) => {
  return await db.Loan.findByPk(id, {
    include: [db.Guarantor, { model: db.Member, include: [db.User] }],
  });
};

const createLoan = async (data) => {
  const result = await db.sequelize.transaction({
    isolationLevel: db.Sequelize.Transaction.ISOLATION_LEVELS.SERIALIZABLE,
  }, async (transaction) => {
    const existingLoan = await db.Loan.findOne({
      where: { memberId: data.memberId, status: { [db.Sequelize.Op.in]: RESTRICTED_LOAN_STATUSES } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existingLoan) {
      const error = new Error('You already have an active or pending loan application');
      error.statusCode = 409;
      throw error;
    }
    const emergency = isEmergencyLoan(data.type);
    const risk = emergency ? await runEmergencyEligibilityChecks(data.memberId) : null;
    const selfGuaranteed = data.selfGuarantee === true || data.selfGuaranteed === true;
    const requiresGuarantors = !selfGuaranteed && !emergency && Array.isArray(data.guarantors) && data.guarantors.length > 0;
    const loan = await db.Loan.create({
      memberId: data.memberId,
      amount: data.amount,
      interestRate: data.interestRate,
      duration: data.duration,
      reason: data.reason || data.purpose || null,
      status: emergency && risk.eligible ? 'APPROVED' : requiresGuarantors ? 'PENDING_GUARANTORS' : data.status || 'UNDER_REVIEW',
      type: data.type,
      multiplier: data.multiplier,
      selfGuaranteed,
      selfGuaranteedAmount: selfGuaranteed ? Number(data.selfGuaranteedAmount || data.amount || 0) : 0,
      approvedById: data.approvedById,
      approvalStage: emergency && risk.eligible ? 'FINANCE' : requiresGuarantors ? 'INITIAL' : data.approvalStage || 'FINANCE',
      decidedAt: emergency && risk.eligible ? new Date() : null,
      principalBalance: emergency && risk.eligible ? Number(data.amount) : null,
      lastInterestAccrualAt: emergency && risk.eligible ? new Date() : null,
      nextPaymentDueAt: emergency && risk.eligible ? addMonths(new Date(), 1) : null,
    }, { transaction });

    if (data.guarantors && data.guarantors.length > 0) {
      for (const guarantor of data.guarantors) {
        await db.Guarantor.create({
          loanId: loan.id,
          memberId: guarantor.memberId,
          amount: guarantor.amount,
          status: 'PENDING',
          requestToken: crypto.randomBytes(32).toString('hex'),
          tokenExpiresAt: new Date(Date.now() + GUARANTOR_TOKEN_TTL_MS),
        }, { transaction });
      }
    }

    if (emergency && !risk.eligible) {
      await loan.update({
        status: 'REJECTED',
        rejectionReason: 'Automated emergency eligibility checks failed.',
        decidedAt: new Date(),
      }, { transaction });
    }

    const walletTransaction = emergency && loan.status === 'APPROVED'
      ? await finalizeLoanDisbursement(loan, transaction)
      : null;

    return {
      loanId: loan.id,
      emergency,
      risk,
      transactionId: walletTransaction?.transactionId || walletTransaction?.id || null,
      disbursementDeadline: emergency && loan.status === 'APPROVED'
        ? new Date(Date.now() + 60 * 60 * 1000)
        : null,
    };
  });

  const createdLoan = await getLoanById(result.loanId);
  try {
    if (result.emergency) {
      if (result.risk?.eligible) {
        await notificationService.createFinanceEmergencyAutoApprovalNotifications(result.loanId, {
          riskChecks: result.risk.checks,
          disbursementDeadline: result.disbursementDeadline,
        });
        await notificationService.createMemberLoanDecisionNotification(result.loanId, 'APPROVED', { skipEmail: true });
      } else {
        await notificationService.createMemberLoanDecisionNotification(result.loanId, 'REJECTED', {
          reason: 'Automated emergency eligibility checks failed.',
        });
      }
    } else if (createdLoan?.Guarantors?.length) {
      await notificationService.createGuarantorRequestNotifications(result.loanId);
    } else {
      await notificationService.createFinanceLoanRequestNotifications(result.loanId);
    }
  } catch (error) {
    logger.error('Loan request saved but notification side-effect failed', {
      loanId: result.loanId,
      error: error.message,
    });
  }

  return {
    loan: createdLoan,
    transactionId: result.transactionId,
    autoApproved: Boolean(result.emergency && result.risk?.eligible),
  };
};

const updateLoan = async (id, data) => {
  const loan = await db.Loan.findByPk(id);
  if (!loan) return null;
  await loan.update({
    amount: data.amount,
    interestRate: data.interestRate,
    duration: data.duration,
    reason: data.reason || data.purpose,
    status: data.status,
    type: data.type,
    multiplier: data.multiplier,
    approvalStage: data.approvalStage,
    approvedById: data.approvedById,
  });
  return loan;
};

const deleteLoan = async (id) => {
  return await db.Loan.destroy({ where: { id } });
};

const updateLoanStatus = async (id, status, options = {}) => {
  const normalized = String(status || '').toUpperCase();
  const result = await db.sequelize.transaction(async (transaction) => {
    const loan = await db.Loan.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!loan) return null;

    const currentStatus = String(loan.status || '').toUpperCase();
    if (currentStatus === normalized) {
      return { loanId: loan.id, changed: false };
    }

    const allowedDecisionStatuses = normalized === 'REJECTED'
      ? ['PENDING', 'UNDER_REVIEW', 'PENDING_GUARANTORS']
      : ['PENDING', 'UNDER_REVIEW'];
    if (['APPROVED', 'REJECTED'].includes(normalized)
      && !allowedDecisionStatuses.includes(currentStatus)) {
      const error = new Error(`This loan can no longer be ${normalized.toLowerCase()}. Its current status is ${currentStatus}.`);
      error.statusCode = 409;
      throw error;
    }

    const decisionTime = new Date();

    await loan.update({
      amount: options.approvedAmount ?? loan.amount,
      status: normalized,
      approvedById: options.approvedById || loan.approvedById,
      interestRate: options.interestRate ?? loan.interestRate,
      duration: options.duration ?? loan.duration,
      rejectionReason: normalized === 'REJECTED' ? options.reason || loan.rejectionReason : loan.rejectionReason,
      decidedAt: ['APPROVED', 'REJECTED'].includes(normalized) ? decisionTime : loan.decidedAt,
      principalBalance: normalized === 'APPROVED' ? Number(options.approvedAmount ?? loan.amount) : loan.principalBalance,
      accruedInterest: normalized === 'APPROVED' ? 0 : loan.accruedInterest,
      lastInterestAccrualAt: normalized === 'APPROVED' ? decisionTime : loan.lastInterestAccrualAt,
      nextPaymentDueAt: normalized === 'APPROVED' ? addMonths(decisionTime, 1) : loan.nextPaymentDueAt,
    }, { transaction });

    return { loanId: loan.id, changed: true };
  });

  if (!result) return null;

  if (result.changed && ['APPROVED', 'REJECTED'].includes(normalized)) {
    await notificationService.createMemberLoanDecisionNotification(result.loanId, normalized, options)
      .catch((error) => logger.error('Loan decision notification failed', {
        module: 'loans',
        loanId: result.loanId,
        status: normalized,
        error: error.message,
      }));
  }

  return getLoanById(result.loanId);
};

const disburseLoan = async (id, options = {}) => {
  const result = await db.sequelize.transaction(async (transaction) => {
    const loan = await db.Loan.findByPk(id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!loan) return null;

    const status = String(loan.status || '').toUpperCase();
    if (!['APPROVED', 'ACTIVE', 'DISBURSED'].includes(status)) {
      const error = new Error('Loan must be approved before disbursement');
      error.statusCode = 400;
      throw error;
    }

    await loan.update({
      status: 'ACTIVE',
      approvedById: options.disbursedById || loan.approvedById,
      principalBalance: loan.principalBalance ?? Number(loan.amount || 0),
      accruedInterest: loan.accruedInterest ?? 0,
      lastInterestAccrualAt: loan.lastInterestAccrualAt || new Date(),
      nextPaymentDueAt: loan.nextPaymentDueAt || addMonths(new Date(), 1),
    }, { transaction });

    const walletTransaction = await finalizeLoanDisbursement(loan, transaction);
    return {
      loanId: loan.id,
      walletTransactionId: walletTransaction?.transactionId || walletTransaction?.id || null,
    };
  });

  if (!result) return null;
  return {
    loan: await getLoanById(result.loanId),
    walletTransactionId: result.walletTransactionId,
  };
};

const getGuarantorRequest = async (token) => {
  const guarantor = await db.Guarantor.findOne({
    where: { requestToken: token },
    include: [
      {
        model: db.Loan,
        include: [{ model: db.Member, include: [db.User] }],
      },
      { model: db.Member, include: [db.User] },
    ],
  });
  if (!guarantor) return null;

  const expired = guarantor.tokenExpiresAt && new Date(guarantor.tokenExpiresAt).getTime() < Date.now();
  if (expired && guarantor.status === 'PENDING') {
    await guarantor.update({ status: 'EXPIRED' });
  }
  return { guarantor, expired };
};

const respondToGuarantorRequest = async (token, decision, amount) => {
  const normalized = String(decision || '').toUpperCase();
  if (!['ACCEPTED', 'REJECTED'].includes(normalized)) {
    const error = new Error('Decision must be ACCEPTED or REJECTED');
    error.statusCode = 400;
    throw error;
  }

  const result = await db.sequelize.transaction(async (transaction) => {
    const guarantor = await db.Guarantor.findOne({
      where: { requestToken: token },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!guarantor) return null;

    const expired = guarantor.tokenExpiresAt && new Date(guarantor.tokenExpiresAt).getTime() < Date.now();
    if (expired) {
      await guarantor.update({ status: 'EXPIRED' }, { transaction });
      const error = new Error('This guarantor link has expired');
      error.statusCode = 410;
      throw error;
    }

    if (guarantor.status !== 'PENDING') {
      return { loanId: guarantor.loanId, guarantorId: guarantor.id, status: guarantor.status };
    }

    const acceptedAmount = Number(amount || guarantor.amount || 0);
    if (normalized === 'ACCEPTED' && (!Number.isFinite(acceptedAmount) || acceptedAmount <= 0)) {
      const error = new Error('Guarantee amount is required');
      error.statusCode = 400;
      throw error;
    }
    if (normalized === 'ACCEPTED') {
      const availableSavings = await getAvailableGuaranteeSavings(guarantor.memberId, guarantor.id);
      if (acceptedAmount > availableSavings) {
        const error = new Error(`Guarantee amount exceeds available savings. Available guarantee limit is KES ${availableSavings.toLocaleString()}.`);
        error.statusCode = 400;
        throw error;
      }
    }

    await guarantor.update({
      status: normalized,
      amount: normalized === 'ACCEPTED' ? acceptedAmount : guarantor.amount,
      respondedAt: new Date(),
    }, { transaction });

    const allGuarantors = await db.Guarantor.findAll({
      where: { loanId: guarantor.loanId },
      transaction,
    });
    const loan = await db.Loan.findByPk(guarantor.loanId, { transaction });
    const acceptedTotal = allGuarantors.reduce((sum, item) => {
      const status = item.id === guarantor.id ? normalized : item.status;
      const nextAmount = item.id === guarantor.id && normalized === 'ACCEPTED' ? acceptedAmount : item.amount;
      return status === 'ACCEPTED' ? sum + Number(nextAmount || 0) : sum;
    }, 0);
    const fullyGuaranteed = acceptedTotal >= Number(loan?.amount || 0);

    if (fullyGuaranteed) {
      await db.Loan.update(
        { status: 'UNDER_REVIEW', approvalStage: 'FINANCE' },
        { where: { id: guarantor.loanId }, transaction },
      );
    }

    return { loanId: guarantor.loanId, guarantorId: guarantor.id, status: normalized, allAccepted: fullyGuaranteed };
  });

  if (!result) return null;
  await notificationService.createApplicantGuarantorDecisionNotification(result.loanId, result.guarantorId);
  if (result.allAccepted) {
    await notificationService.createFinanceLoanRequestNotifications(result.loanId);
  }
  return getLoanById(result.loanId);
};

module.exports = {
  getAllLoans,
  getLoanById,
  createLoan,
  updateLoan,
  deleteLoan,
  updateLoanStatus,
  disburseLoan,
  getGuarantorRequest,
  respondToGuarantorRequest,
};
