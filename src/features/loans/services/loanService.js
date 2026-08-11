const db = require('../../../models');
const notificationService = require('../../notifications/services/notificationService');
const logger = require('../../../shared/utils/logger');
const crypto = require('crypto');

const GUARANTOR_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

const isEmergencyLoan = (type) => String(type || '').toUpperCase() === 'EMERGENCY';

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

  if (existingWalletTx) return;

  const previousWithdrawable = Number(wallet.withdrawableBalance || 0);
  const nextWithdrawable = previousWithdrawable + amount;
  await wallet.update({ withdrawableBalance: nextWithdrawable }, { transaction });

  const txId = makeWalletTransactionId();
  await db.WalletTransaction.create({
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
  const result = await db.sequelize.transaction(async (transaction) => {
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

    if (emergency && loan.status === 'APPROVED') {
      await finalizeLoanDisbursement(loan, transaction);
    }

    return {
      loanId: loan.id,
      emergency,
      risk,
      disbursementDeadline: emergency && loan.status === 'APPROVED'
        ? new Date(Date.now() + 60 * 60 * 1000)
        : null,
    };
  });

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
  }
  const createdLoan = await getLoanById(result.loanId);
  if (!result.emergency && createdLoan?.Guarantors?.length) {
    await notificationService.createGuarantorRequestNotifications(result.loanId);
  } else if (!result.emergency) {
    await notificationService.createFinanceLoanRequestNotifications(result.loanId);
  }

  return createdLoan;
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

    await loan.update({
      amount: options.approvedAmount ?? loan.amount,
      status: normalized,
      approvedById: options.approvedById || loan.approvedById,
      interestRate: options.interestRate ?? loan.interestRate,
      duration: options.duration ?? loan.duration,
      rejectionReason: normalized === 'REJECTED' ? options.reason || loan.rejectionReason : loan.rejectionReason,
      decidedAt: ['APPROVED', 'REJECTED'].includes(normalized) ? new Date() : loan.decidedAt,
    }, { transaction });

    return loan.id;
  });

  if (!result) return null;

  if (normalized === 'APPROVED') {
    await db.sequelize.transaction(async (transaction) => {
      const loan = await db.Loan.findByPk(result, { transaction });
      if (loan) await finalizeLoanDisbursement(loan, transaction);
    }).catch((error) => logger.error('Loan disbursement finalization failed', {
      module: 'loans',
      loanId: result,
      error: error.message,
    }));
  }

  if (['APPROVED', 'REJECTED'].includes(normalized)) {
    await notificationService.createMemberLoanDecisionNotification(result, normalized, options)
      .catch((error) => logger.error('Loan decision notification failed', {
        module: 'loans',
        loanId: result,
        status: normalized,
        error: error.message,
      }));
  }

  return getLoanById(result);
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
  getGuarantorRequest,
  respondToGuarantorRequest,
};
