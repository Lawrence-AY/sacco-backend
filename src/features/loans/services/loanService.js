const db = require('../../../models');
const notificationService = require('../../notifications/services/notificationService');
const logger = require('../../../shared/utils/logger');
const crypto = require('crypto');
const { getMemberCapacity, getLoanCoverage, money } = require('./guaranteeCapacityService');

const GUARANTOR_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

const isEmergencyLoan = (type) => String(type || '').toUpperCase() === 'EMERGENCY';
const LOAN_PRODUCT_LIMITS = Object.freeze({
  EMERGENCY: 50000,
  EDUCATION: 100000,
  WELFARE: 100000,
  DEVELOPMENT: 250000,
});
// Prevent duplicate in-flight applications, but allow a member with an active
// facility to apply for another loan when all product eligibility rules pass.
const RESTRICTED_LOAN_STATUSES = ['PENDING', 'PENDING_GUARANTORS', 'FULLY_COVERED', 'UNDER_REVIEW'];

const addMonths = (value, months) => {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date;
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
  const normalizedType = String(data.type || '').toUpperCase();
  const productLimit = LOAN_PRODUCT_LIMITS[normalizedType];
  if (!productLimit) {
    const error = new Error('Select a valid loan product');
    error.statusCode = 400;
    throw error;
  }
  if (Number(data.amount || 0) > productLimit) {
    const error = new Error(`${normalizedType.toLowerCase().replace(/^./, (letter) => letter.toUpperCase())} Loan is limited to KES ${productLimit.toLocaleString()}`);
    error.statusCode = 400;
    throw error;
  }
  const result = await db.sequelize.transaction(async (transaction) => {
    const existingLoan = await db.Loan.findOne({
      where: { memberId: data.memberId, status: { [db.Sequelize.Op.in]: RESTRICTED_LOAN_STATUSES } },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existingLoan) {
      const error = new Error('You already have a loan application awaiting a decision');
      error.statusCode = 409;
      throw error;
    }
    const emergency = isEmergencyLoan(data.type);
    const risk = emergency ? await runEmergencyEligibilityChecks(data.memberId) : null;
    const wantsSelfGuarantee = data.selfGuarantee === true || data.selfGuaranteed === true;
    const applicantCapacity = await getMemberCapacity(data.memberId, { transaction, lock: transaction.LOCK.UPDATE });
    const selfGuaranteedAmount = !emergency && wantsSelfGuarantee
      ? money(Math.min(Number(data.amount || 0), applicantCapacity?.freeSavings || 0))
      : 0;
    const selfGuaranteed = selfGuaranteedAmount > 0;
    const externalGuaranteeRequired = money(Math.max(0, Number(data.amount || 0) - selfGuaranteedAmount));
    const requestedGuarantors = emergency ? [] : (Array.isArray(data.guarantors) ? data.guarantors : []);
    const requiresGuarantors = externalGuaranteeRequired > 0 && requestedGuarantors.length > 0;
    if (!emergency && externalGuaranteeRequired > 0 && !requiresGuarantors) {
      const error = new Error(`External guarantees of KES ${externalGuaranteeRequired.toLocaleString()} are required`);
      error.statusCode = 400;
      throw error;
    }
    const loan = await db.Loan.create({
      memberId: data.memberId,
      amount: data.amount,
      interestRate: data.interestRate,
      duration: data.duration,
      reason: data.reason || data.purpose || null,
      status: emergency && risk.eligible ? 'APPROVED' : requiresGuarantors ? 'PENDING_GUARANTORS' : 'FULLY_COVERED',
      type: data.type,
      multiplier: data.multiplier,
      selfGuaranteed,
      selfGuaranteedAmount,
      approvedById: data.approvedById,
      approvalStage: emergency && risk.eligible ? 'FINANCE' : requiresGuarantors ? 'INITIAL' : 'FINANCE',
      decidedAt: emergency && risk.eligible ? new Date() : null,
      principalBalance: emergency && risk.eligible ? Number(data.amount) : null,
      lastInterestAccrualAt: emergency && risk.eligible ? new Date() : null,
      nextPaymentDueAt: emergency && risk.eligible ? addMonths(new Date(), 1) : null,
    }, { transaction });

    if (requestedGuarantors.length > 0) {
      const uniqueIds = new Set(requestedGuarantors.map((item) => item.memberId));
      if (uniqueIds.size !== requestedGuarantors.length || uniqueIds.has(data.memberId)) {
        const error = new Error('A borrower cannot guarantee their own external request and each guarantor may only be selected once');
        error.statusCode = 400;
        throw error;
      }
      const eligibleGuarantors = [];
      for (const guarantor of requestedGuarantors) {
        const capacity = await getMemberCapacity(guarantor.memberId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!capacity?.isEligibleToGuarantee) {
          const error = new Error('A selected member is no longer eligible to guarantee this loan');
          error.statusCode = 409;
          throw error;
        }
        eligibleGuarantors.push({ memberId: guarantor.memberId, capacity: money(capacity.freeSavings), reservedAmount: 0 });
      }
      let remainingToReserve = externalGuaranteeRequired;
      let candidates = eligibleGuarantors;
      while (remainingToReserve > 0 && candidates.length) {
        const equalShare = Math.max(0.01, money(remainingToReserve / candidates.length));
        let allocatedThisRound = 0;
        for (const candidate of candidates) {
          const unusedCapacity = money(candidate.capacity - candidate.reservedAmount);
          const allocation = money(Math.min(equalShare, unusedCapacity, remainingToReserve - allocatedThisRound));
          candidate.reservedAmount = money(candidate.reservedAmount + allocation);
          allocatedThisRound = money(allocatedThisRound + allocation);
        }
        if (allocatedThisRound <= 0) break;
        remainingToReserve = money(remainingToReserve - allocatedThisRound);
        candidates = candidates.filter((candidate) => money(candidate.capacity - candidate.reservedAmount) > 0);
      }
      if (remainingToReserve > 0) {
        const error = new Error('The selected guarantors cannot fully secure the requested amount. Select an additional eligible guarantor.');
        error.statusCode = 409;
        throw error;
      }
      for (const guarantor of eligibleGuarantors) {
        if (guarantor.reservedAmount <= 0) continue;
        await db.Guarantor.create({
          loanId: loan.id,
          memberId: guarantor.memberId,
          amount: guarantor.reservedAmount,
          status: 'PENDING',
          requestToken: crypto.randomBytes(32).toString('hex'),
          tokenExpiresAt: new Date(Date.now() + GUARANTOR_TOKEN_TTL_MS),
          holdPlacedAt: new Date(),
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
      ? ['PENDING', 'UNDER_REVIEW', 'PENDING_GUARANTORS', 'FULLY_COVERED']
      : ['PENDING', 'UNDER_REVIEW', 'FULLY_COVERED'];
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

    let releasedGuarantorIds = [];
    if (normalized === 'REJECTED') {
      const held = await db.Guarantor.findAll({
        where: { loanId: loan.id, status: { [db.Sequelize.Op.in]: ['PENDING', 'ACCEPTED'] } },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      releasedGuarantorIds = held.map((item) => item.id);
      await Promise.all(held.map((item) => item.update({
        status: item.status === 'PENDING' ? 'CANCELLED' : 'RELEASED',
        cancellationReason: options.reason || 'Loan application was rejected or cancelled',
        releasedAt: decisionTime,
      }, { transaction })));
    }

    return { loanId: loan.id, changed: true, releasedGuarantorIds };
  });

  if (!result) return null;

  if (result.changed && ['APPROVED', 'REJECTED'].includes(normalized)) {
    notificationService.createMemberLoanDecisionNotification(result.loanId, normalized, options)
      .catch((error) => logger.error('Loan decision notification failed', {
        module: 'loans',
        loanId: result.loanId,
        status: normalized,
        error: error.message,
      }));
  }
  if (normalized === 'REJECTED' && result.releasedGuarantorIds?.length) {
    notificationService.createGuarantorExpirationNotifications(
      result.loanId,
      result.releasedGuarantorIds,
      options.reason || 'Loan application was rejected or cancelled',
    ).catch((error) => logger.error('Guarantor release notification failed', { loanId: result.loanId, error: error.message }));
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

const getGuarantorRequest = async (token, actorMemberId) => {
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
  if (guarantor.memberId !== actorMemberId) {
    const error = new Error('This guarantor request belongs to another member');
    error.statusCode = 403;
    throw error;
  }

  const expired = guarantor.tokenExpiresAt && new Date(guarantor.tokenExpiresAt).getTime() < Date.now();
  if (expired && guarantor.status === 'PENDING') {
    await guarantor.update({ status: 'EXPIRED', cancellationReason: 'Guarantor response window expired', releasedAt: new Date() });
  }
  const [capacity, coverage] = await Promise.all([
    getMemberCapacity(guarantor.memberId, { excludeGuarantorId: guarantor.id }),
    getLoanCoverage(guarantor.loanId),
  ]);
  const maxAllowedPledge = money(Math.min(
    capacity?.freeSavings || 0,
    coverage?.acceptedRemaining || 0,
  ));
  return { guarantor, expired, capacity, coverage, maxAllowedPledge };
};

const respondToGuarantorRequest = async (token, decision, amount, actorMemberId) => {
  const normalized = String(decision || '').toUpperCase();
  if (!['ACCEPTED', 'REJECTED'].includes(normalized)) {
    const error = new Error('Decision must be ACCEPTED or REJECTED');
    error.statusCode = 400;
    throw error;
  }

  const result = await db.sequelize.transaction(async (transaction) => {
    const guarantorLookup = await db.Guarantor.findOne({ where: { requestToken: token }, transaction });
    if (!guarantorLookup) return null;
    const loan = await db.Loan.findByPk(guarantorLookup.loanId, { transaction, lock: transaction.LOCK.UPDATE });
    const guarantor = await db.Guarantor.findByPk(guarantorLookup.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (guarantor.memberId !== actorMemberId) {
      const error = new Error('You are not authorized to respond to this guarantor request');
      error.statusCode = 403;
      throw error;
    }

    const expired = guarantor.tokenExpiresAt && new Date(guarantor.tokenExpiresAt).getTime() < Date.now();
    if (expired) {
      await guarantor.update({ status: 'EXPIRED', cancellationReason: 'Guarantor response window expired', releasedAt: new Date() }, { transaction });
      const error = new Error('This guarantor link has expired');
      error.statusCode = 410;
      throw error;
    }

    if (guarantor.status !== 'PENDING') {
      return { loanId: guarantor.loanId, guarantorId: guarantor.id, status: guarantor.status };
    }

    const acceptedAmount = Number(amount === undefined || amount === null || amount === '' ? guarantor.amount : amount);
    if (normalized === 'ACCEPTED' && (!Number.isFinite(acceptedAmount) || acceptedAmount <= 0)) {
      const error = new Error('Guarantee amount is required');
      error.statusCode = 400;
      throw error;
    }
    if (normalized === 'ACCEPTED') {
      const capacity = await getMemberCapacity(guarantor.memberId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
        excludeGuarantorId: guarantor.id,
      });
      const coverage = await getLoanCoverage(guarantor.loanId, { transaction });
      const maxAllowed = money(Math.min(
        capacity?.freeSavings || 0,
        coverage?.acceptedRemaining || 0,
      ));
      if (!capacity?.isEligibleToGuarantee || acceptedAmount > maxAllowed) {
        const error = new Error('Insufficient free savings to complete this guarantee');
        error.statusCode = 409;
        throw error;
      }
    }

    await guarantor.update({
      status: normalized,
      amount: normalized === 'ACCEPTED' ? acceptedAmount : guarantor.amount,
      respondedAt: new Date(),
      releasedAt: normalized === 'REJECTED' ? new Date() : guarantor.releasedAt,
      cancellationReason: normalized === 'REJECTED' ? 'Guarantor declined the request' : guarantor.cancellationReason,
    }, { transaction });

    const allGuarantors = await db.Guarantor.findAll({
      where: { loanId: guarantor.loanId },
      transaction,
    });
    const acceptedTotal = allGuarantors.reduce((sum, item) => {
      const status = item.id === guarantor.id ? normalized : item.status;
      const nextAmount = item.id === guarantor.id && normalized === 'ACCEPTED' ? acceptedAmount : item.amount;
      return status === 'ACCEPTED' ? sum + Number(nextAmount || 0) : sum;
    }, 0);
    const fullyGuaranteed = money(acceptedTotal + Number(loan?.selfGuaranteedAmount || 0)) >= money(loan?.amount || 0);
    let cancelledGuarantorIds = [];

    if (fullyGuaranteed) {
      await loan.update({ status: 'FULLY_COVERED', approvalStage: 'FINANCE' }, { transaction });
      const pending = allGuarantors.filter((item) => item.id !== guarantor.id && item.status === 'PENDING');
      cancelledGuarantorIds = pending.map((item) => item.id);
      if (cancelledGuarantorIds.length) {
        await db.Guarantor.update({
          status: 'CANCELLED',
          cancellationReason: 'Loan requirement fully satisfied by other guarantors',
          releasedAt: new Date(),
        }, { where: { id: { [db.Sequelize.Op.in]: cancelledGuarantorIds } }, transaction });
      }
    }

    return { loanId: guarantor.loanId, guarantorId: guarantor.id, status: normalized, allAccepted: fullyGuaranteed, cancelledGuarantorIds };
  });

  if (!result) return null;
  await notificationService.createApplicantGuarantorDecisionNotification(result.loanId, result.guarantorId);
  if (result.cancelledGuarantorIds?.length) {
    await notificationService.createGuarantorExpirationNotifications(result.loanId, result.cancelledGuarantorIds);
  }
  if (result.allAccepted) {
    await notificationService.createFinanceLoanRequestNotifications(result.loanId);
  }
  return getLoanById(result.loanId);
};

const expireStaleGuarantorRequests = async () => {
  const expiredByLoan = await db.sequelize.transaction(async (transaction) => {
    const stale = await db.Guarantor.findAll({
      where: {
        status: 'PENDING',
        tokenExpiresAt: { [db.Sequelize.Op.lt]: new Date() },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!stale.length) return new Map();
    const releasedAt = new Date();
    await Promise.all(stale.map((item) => item.update({
      status: 'EXPIRED',
      cancellationReason: 'Guarantor response window expired',
      releasedAt,
    }, { transaction })));
    return stale.reduce((map, item) => {
      const ids = map.get(item.loanId) || [];
      ids.push(item.id);
      map.set(item.loanId, ids);
      return map;
    }, new Map());
  });
  for (const [loanId, ids] of expiredByLoan.entries()) {
    await notificationService.createGuarantorExpirationNotifications(loanId, ids, 'Guarantor response window expired');
  }
  return [...expiredByLoan.values()].reduce((sum, ids) => sum + ids.length, 0);
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
  expireStaleGuarantorRequests,
};
