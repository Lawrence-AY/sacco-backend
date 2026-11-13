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
    include: [
      { model: db.Guarantor, include: [{ model: db.Member, include: [{ model: db.User, attributes: ['id', 'name', 'firstName', 'lastName'] }] }] },
      { model: db.Member, include: [db.User] },
    ],
  });
};

const createLoan = async (data) => {
  const normalizedType = String(data.type || '').toUpperCase();
  const requestedLoanAmount = Number(data.amount || 0);
  const productLimit = LOAN_PRODUCT_LIMITS[normalizedType];
  if (!productLimit) {
    const error = new Error('Select a valid loan product');
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(requestedLoanAmount) || requestedLoanAmount <= 0) {
    const error = new Error('Loan amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }
  if (requestedLoanAmount > productLimit) {
    const error = new Error(`${normalizedType.toLowerCase().replace(/^./, (letter) => letter.toUpperCase())} Loan is limited to KES ${productLimit.toLocaleString()}`);
    error.statusCode = 400;
    throw error;
  }
  const result = await db.sequelize.transaction(async (transaction) => {
    const emergency = isEmergencyLoan(data.type);
    const risk = emergency ? await runEmergencyEligibilityChecks(data.memberId) : null;
    const wantsSelfGuarantee = data.selfGuarantee === true || data.selfGuaranteed === true;
    const membersToLock = [...new Set([
      String(data.memberId),
      ...(Array.isArray(data.guarantors) ? data.guarantors.map((item) => String(item.memberId)) : []),
    ])].sort();
    await db.Member.findAll({
      where: { id: { [db.Sequelize.Op.in]: membersToLock } },
      attributes: ['id'],
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const applicantCapacity = await getMemberCapacity(data.memberId, { transaction, lock: transaction.LOCK.UPDATE });
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
      const uniqueIds = new Set(requestedGuarantors.map((item) => String(item.memberId)));
      if (uniqueIds.size !== requestedGuarantors.length || uniqueIds.has(String(data.memberId))) {
        const error = new Error('A borrower cannot guarantee their own external request and each guarantor may only be selected once');
        error.statusCode = 400;
        throw error;
      }
      const requestedTotal = money(requestedGuarantors.reduce((sum, item) => sum + Number(item.amount || 0), 0));
      if (requestedTotal !== externalGuaranteeRequired) {
        const error = new Error(`Guarantor amounts must total the remaining guarantee requirement of KES ${externalGuaranteeRequired.toLocaleString()}`);
        error.statusCode = 400;
        throw error;
      }
      const eligibleGuarantors = [];
      for (const guarantor of [...requestedGuarantors].sort((left, right) => String(left.memberId).localeCompare(String(right.memberId)))) {
        const requestedAmount = money(guarantor.amount);
        if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
          const error = new Error('Each guarantor amount must be greater than zero');
          error.statusCode = 400;
          throw error;
        }
        const capacity = await getMemberCapacity(guarantor.memberId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!capacity?.isEligibleToGuarantee) {
          const error = new Error('A selected member is no longer eligible to guarantee this loan');
          error.statusCode = 409;
          throw error;
        }
        if (requestedAmount > money(capacity.freeSavings)) {
          const error = new Error(`A selected guarantor has only KES ${money(capacity.freeSavings).toLocaleString()} available to guarantee`);
          error.statusCode = 409;
          throw error;
        }
        eligibleGuarantors.push({ memberId: guarantor.memberId, amount: requestedAmount });
      }
      for (const guarantor of eligibleGuarantors) {
        await db.Guarantor.create({
          loanId: loan.id,
          memberId: guarantor.memberId,
          amount: guarantor.amount,
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
    } else {
      await notificationService.createFinanceLoanRequestNotifications(result.loanId);
      if (createdLoan?.Guarantors?.length) await notificationService.createGuarantorRequestNotifications(result.loanId);
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

    if (normalized === 'APPROVED' && String(loan.type || '').toUpperCase() !== 'EMERGENCY') {
      const coverage = await getLoanCoverage(loan.id, { transaction });
      if (!coverage?.fullyGuaranteed) {
        const error = new Error('This loan cannot be approved until the full guarantee requirement is accepted');
        error.statusCode = 409;
        throw error;
      }
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
    if (String(loan.type || '').toUpperCase() !== 'EMERGENCY') {
      const coverage = await getLoanCoverage(loan.id, { transaction });
      if (!coverage?.fullyGuaranteed) {
        const error = new Error('The full guarantee requirement must be satisfied before disbursement');
        error.statusCode = 409;
        throw error;
      }
    }

    await loan.update({
      status: 'ACTIVE',
      disbursementStatus: 'COMPLETE',
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

const updateLoanDisbursementStatus = async (id, status, options = {}) => {
  const normalized = String(status || '').toUpperCase();
  if (!['COMPLETE', 'DENIED'].includes(normalized)) {
    const error = new Error('Disbursement status must be COMPLETE or DENIED');
    error.statusCode = 400;
    throw error;
  }
  const loan = await db.sequelize.transaction(async (transaction) => {
    const record = await db.Loan.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!record) return null;
    const loanStatus = String(record.status || '').toUpperCase();
    if (!['APPROVED', 'ACTIVE', 'DISBURSED'].includes(loanStatus)) {
      const error = new Error('Only an approved loan can have its disbursement confirmed or denied');
      error.statusCode = 409;
      throw error;
    }
    if (String(record.type || '').toUpperCase() !== 'EMERGENCY') {
      const coverage = await getLoanCoverage(record.id, { transaction });
      if (!coverage?.fullyGuaranteed) {
        const error = new Error('The full guarantee requirement must be satisfied before disbursement can be confirmed');
        error.statusCode = 409;
        throw error;
      }
    }
    const current = String(record.disbursementStatus || 'PENDING').toUpperCase();
    if (current !== 'PENDING' && current !== normalized) {
      const error = new Error(`Disbursement is already marked ${current.toLowerCase()}`);
      error.statusCode = 409;
      throw error;
    }
    const values = { disbursementStatus: normalized };
    if (normalized === 'COMPLETE') {
      const now = new Date();
      values.status = 'ACTIVE';
      values.approvedById = options.updatedById || record.approvedById;
      values.principalBalance = record.principalBalance ?? Number(record.amount || 0);
      values.accruedInterest = record.accruedInterest ?? 0;
      values.lastInterestAccrualAt = record.lastInterestAccrualAt || now;
      values.nextPaymentDueAt = record.nextPaymentDueAt || addMonths(now, 1);
    }
    await record.update(values, { transaction });
    return record.id;
  });
  return loan ? getLoanById(loan) : null;
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

  const tokenExpired = guarantor.tokenExpiresAt && new Date(guarantor.tokenExpiresAt).getTime() < Date.now();
  if (tokenExpired && guarantor.status === 'PENDING') {
    await db.Guarantor.update({ status: 'EXPIRED', cancellationReason: 'Guarantor response window expired', releasedAt: new Date() }, {
      where: { id: guarantor.id, status: 'PENDING' },
    });
    await guarantor.reload();
  }
  const expired = String(guarantor.status || '').toUpperCase() === 'EXPIRED';
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
    if (String(guarantorLookup.memberId) !== String(actorMemberId)) {
      const error = new Error('You are not authorized to respond to this guarantor request');
      error.statusCode = 403;
      throw error;
    }
    await getMemberCapacity(actorMemberId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      excludeGuarantorId: guarantorLookup.id,
    });
    const loan = await db.Loan.findByPk(guarantorLookup.loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) return null;
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
      return { expired: true, loanId: guarantor.loanId, guarantorId: guarantor.id, changed: true };
    }

    if (guarantor.status !== 'PENDING') {
      return { loanId: guarantor.loanId, guarantorId: guarantor.id, status: guarantor.status, changed: false };
    }
    if (!['PENDING_GUARANTORS', 'PENDING', 'UNDER_REVIEW'].includes(String(loan.status || '').toUpperCase())) {
      const error = new Error('This loan application is no longer awaiting guarantor confirmation');
      error.statusCode = 409;
      throw error;
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
    const progress = calculateGuaranteeProgress({
      loanAmount: loan.amount,
      selfGuaranteedAmount: loan.selfGuaranteedAmount,
      pledges: allGuarantors,
    });
    const fullyGuaranteed = progress.fullyGuaranteed;
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

    return { loanId: guarantor.loanId, guarantorId: guarantor.id, status: normalized, allAccepted: fullyGuaranteed, cancelledGuarantorIds, changed: true, progress };
  });

  if (!result) return null;
  if (result.expired) {
    const error = new Error('This guarantor link has expired');
    error.statusCode = 410;
    throw error;
  }
  if (result.changed) {
    const sideEffects = [
      notificationService.createApplicantGuarantorDecisionNotification(result.loanId, result.guarantorId, {
        fullyGuaranteed: result.allAccepted,
        totalGuaranteed: result.progress?.totalGuaranteed,
      }),
    ];
    if (result.cancelledGuarantorIds?.length) {
      sideEffects.push(notificationService.createGuarantorExpirationNotifications(result.loanId, result.cancelledGuarantorIds));
    }
    const outcomes = await Promise.allSettled(sideEffects);
    outcomes.filter((item) => item.status === 'rejected').forEach((item) => logger.error('Guarantor decision notification failed', {
      module: 'loans', loanId: result.loanId, error: item.reason?.message,
    }));
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
  updateLoanDisbursementStatus,
  getGuarantorRequest,
  respondToGuarantorRequest,
  expireStaleGuarantorRequests,
  LOAN_PRODUCT_LIMITS,
};
