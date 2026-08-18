const db = require('../../../models');
const eventBus = require('../../../services/realtime/eventBus');
const { calculateLoanBalanceQuote, calculateLoanPaymentAllocation, fromCents, toCents } = require('./loanCalculationEngine');

const addMonths = (value, months) => {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date;
};

const getNextDueDate = (loan, paymentDate, allocation) => {
  const { paidOff } = allocation;
  if (paidOff) return null;
  const currentDue = loan.nextPaymentDueAt ? new Date(loan.nextPaymentDueAt) : addMonths(new Date(loan.decidedAt || loan.createdAt || paymentDate), 1);
  const scheduledInstallment = calculateLoanBalanceQuote(loan, paymentDate).scheduledPaymentAmount;
  // Interest-only or undersized payments reduce the balance but do not satisfy
  // the contractual installment, so the existing due date remains in force.
  if (allocation.paymentAmount + 0.005 < scheduledInstallment) return currentDue;
  return addMonths(currentDue, 1);
};

const assertLoanPayable = (loan) => {
  if (!['ACTIVE', 'APPROVED', 'DISBURSED'].includes(String(loan.status || '').toUpperCase())) {
    const error = new Error('Loan is not eligible for repayment');
    error.statusCode = 400;
    throw error;
  }
};

const buildPaymentEventPayload = ({ ledger, repayment, loan, userId, allocation, paymentDate }) => ({
  paymentId: ledger.id,
  loanId: loan.id,
  memberId: loan.memberId,
  userId,
  newOutstandingBalance: allocation.newOutstandingBalance,
  outstandingBalance: allocation.newOutstandingBalance,
  remainingPrincipal: allocation.remainingPrincipal,
  remainingInterest: allocation.remainingInterest,
  principalPaid: allocation.principalPaid,
  interestEarned: allocation.interestEarned,
  interestPaid: allocation.interestPaid,
  totalPaid: allocation.paymentAmount,
  paymentTimestamp: paymentDate.toISOString(),
  nextPaymentDueAt: loan.nextPaymentDueAt,
  loanStatus: loan.status,
  transaction: {
    id: ledger.id,
    type: ledger.type,
    amount: Number(ledger.amount),
    status: ledger.status,
    method: ledger.method,
    reference: ledger.reference,
    loanId: ledger.loanId,
    memberId: ledger.memberId,
    createdAt: ledger.createdAt,
    principalPaid: Number(repayment.principalPaid),
    interestPaid: Number(repayment.interestPaid),
    remainingPrincipal: Number(repayment.remainingPrincipal),
  },
});

const publishLoanPaymentEvent = (payload) => eventBus.publish('LOAN_PAYMENT_PROCESSED', payload, [
  `user:${payload.userId}`,
  'admin:dashboard',
  'finance:dashboard',
]);

const allocateLedgerRepayment = async ({
  ledger,
  loan,
  amount,
  receipt,
  resultDescription,
  paymentChannel,
  evidence,
  postedByUserId,
  transaction,
}) => {
  const paymentDate = new Date();
  const allocation = calculateLoanPaymentAllocation({ loan, amount, paymentDate });
  const nextPaymentDueAt = getNextDueDate(loan, paymentDate, allocation);

  await ledger.update({
    status: 'SUCCESS',
    amount: allocation.paymentAmount,
    reference: receipt || ledger.reference,
    description: resultDescription || ledger.description,
  }, { transaction });

  const repayment = await db.LoanTransaction.create({
    loanId: loan.id,
    memberId: loan.memberId,
    ledgerTransactionId: ledger.id,
    transactionType: 'INTERIM_PAYMENT',
    amount: allocation.paymentAmount,
    principalPaid: allocation.principalPaid,
    interestPaid: allocation.interestPaid,
    remainingPrincipal: allocation.remainingPrincipal,
    accruedDays: allocation.accruedDays,
    metadata: {
      amortization: allocation.amortization,
      payment_channel: paymentChannel || ledger.method,
      receipt: receipt || ledger.reference || null,
      evidence: evidence || null,
      posted_by_id: postedByUserId || null,
      outstanding_before: allocation.outstandingBefore,
      remaining_interest: allocation.remainingInterest,
      remaining_balance: allocation.newOutstandingBalance,
      principal_paid_cents: allocation.principalPaidCents,
      interest_paid_cents: allocation.interestPaidCents,
      outstanding_cents: allocation.newOutstandingCents,
      remaining_installments: allocation.paidOff ? 0 : calculateLoanBalanceQuote(loan, paymentDate).remainingInstallments,
    },
  }, { transaction });

  await loan.update({
    principalBalance: allocation.remainingPrincipal,
    accruedInterest: allocation.remainingInterest,
    lastInterestAccrualAt: paymentDate,
    nextPaymentDueAt,
    status: allocation.paidOff ? 'COMPLETED' : loan.status,
  }, { transaction });

  loan.principalBalance = allocation.remainingPrincipal;
  loan.accruedInterest = allocation.remainingInterest;
  loan.nextPaymentDueAt = nextPaymentDueAt;
  loan.status = allocation.paidOff ? 'COMPLETED' : loan.status;

  const ledgerEntries = [
    {
      transactionId: ledger.id,
      loanId: loan.id,
      memberId: loan.memberId,
      account: 'CASH',
      side: 'DEBIT',
      amount: allocation.paymentAmount,
      memo: 'Loan repayment cash received',
      postedAt: paymentDate,
    },
  ];
  if (allocation.principalPaid > 0) {
    ledgerEntries.push({
      transactionId: ledger.id,
      loanId: loan.id,
      memberId: loan.memberId,
      account: 'LOAN_RECEIVABLE',
      side: 'CREDIT',
      amount: allocation.principalPaid,
      memo: 'Loan principal reduced',
      postedAt: paymentDate,
    });
  }
  if (allocation.interestPaid > 0) {
    ledgerEntries.push({
      transactionId: ledger.id,
      loanId: loan.id,
      memberId: loan.memberId,
      account: 'INTEREST_INCOME',
      side: 'CREDIT',
      amount: allocation.interestPaid,
      memo: 'Loan interest realized',
      postedAt: paymentDate,
    });
  }
  await db.FinancialLedgerEntry.bulkCreate(ledgerEntries, { transaction });

  return { ledger, repayment, loan, allocation, paymentDate, duplicate: false };
};

const postLoanPayment = async ({
  loanId,
  amount,
  reference,
  evidence,
  method = 'MANUAL',
  memberId = null,
  postedByUserId = null,
  actorUser = null,
  source = 'FINANCE',
}) => {
  const result = await db.sequelize.transaction(async (transaction) => {
    const loan = await db.Loan.findByPk(loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) {
      const error = new Error('Loan not found');
      error.statusCode = 404;
      throw error;
    }
    assertLoanPayable(loan);

    if (memberId && loan.memberId !== memberId) {
      const error = new Error('Loan does not belong to the specified member');
      error.statusCode = 403;
      throw error;
    }

    const member = await db.Member.findByPk(loan.memberId, {
      include: [db.User],
      transaction,
    });
    const role = String(actorUser?.role || '').toUpperCase();
    if (role === 'MEMBER' && member?.userId !== actorUser?.id) {
      const error = new Error('You can only submit payments for your own loans');
      error.statusCode = 403;
      throw error;
    }
    if (method === 'MANUAL' && !reference) {
      const error = new Error('Manual repayments require a receipt or evidence reference');
      error.statusCode = 400;
      throw error;
    }

    const ledger = await db.Transaction.create({
      memberId: loan.memberId,
      loanId: loan.id,
      type: 'LOAN_REPAYMENT',
      amount: fromCents(toCents(amount)),
      method,
      status: 'SUCCESS',
      reference: reference || `PAY-${Date.now()}`,
      description: evidence || `${source} loan repayment`,
      paymentCategory: method === 'MPESA' ? 'loan_repayment' : 'loan_manual_repayment',
    }, { transaction });

    const posted = await allocateLedgerRepayment({
      ledger,
      loan,
      amount,
      receipt: ledger.reference,
      resultDescription: ledger.description,
      paymentChannel: method,
      evidence,
      postedByUserId,
      transaction,
    });

    return {
      ...posted,
      eventPayload: buildPaymentEventPayload({
        ...posted,
        userId: member?.userId,
      }),
    };
  });

  if (result.eventPayload.userId) publishLoanPaymentEvent(result.eventPayload);
  return result;
};

const postManualRepayment = (args) => postLoanPayment({
  ...args,
  postedByUserId: args.postedById || args.postedByUserId,
  source: 'FINANCE',
});

const allocateMpesaRepayment = async ({ ledgerTransactionId, receipt, confirmedAmount, resultDescription }) => {
  const result = await db.sequelize.transaction(async (transaction) => {
    const ledger = await db.Transaction.findByPk(ledgerTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ledger) return null;
    const existing = await db.LoanTransaction.findOne({ where: { ledgerTransactionId: ledger.id }, transaction });
    if (existing) return { ledger, repayment: existing, duplicate: true, eventPayload: null };

    const loan = await db.Loan.findByPk(ledger.loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) throw new Error('Loan linked to M-Pesa repayment was not found');
    assertLoanPayable(loan);
    const member = await db.Member.findByPk(loan.memberId, { transaction });
    const posted = await allocateLedgerRepayment({
      ledger,
      loan,
      amount: confirmedAmount ?? ledger.amount,
      receipt,
      resultDescription: resultDescription || 'M-Pesa loan repayment received',
      paymentChannel: 'MPESA_STK',
      transaction,
    });
    return {
      ...posted,
      eventPayload: buildPaymentEventPayload({
        ...posted,
        userId: member?.userId,
      }),
    };
  });

  if (result?.eventPayload?.userId) publishLoanPaymentEvent(result.eventPayload);
  return result;
};

const voidRepayment = async ({ ledgerTransactionId, reason, voidedById }) => (
  db.sequelize.transaction(async (transaction) => {
    const ledger = await db.Transaction.findByPk(ledgerTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ledger) return null;
    const repayment = await db.LoanTransaction.findOne({ where: { ledgerTransactionId }, transaction });
    if (!repayment) {
      await ledger.update({ status: 'FAILED', reference: reason || ledger.reference }, { transaction });
      return { ledger, repayment: null };
    }
    const loan = await db.Loan.findByPk(repayment.loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) throw new Error('Loan linked to repayment was not found');
    const restoredPrincipal = fromCents(toCents(loan.principalBalance || 0) + toCents(repayment.principalPaid || 0));
    const restoredInterest = fromCents(toCents(loan.accruedInterest || 0) + toCents(repayment.interestPaid || 0));
    await loan.update({
      principalBalance: restoredPrincipal,
      accruedInterest: restoredInterest,
      status: String(loan.status || '').toUpperCase() === 'COMPLETED' ? 'ACTIVE' : loan.status,
    }, { transaction });
    await ledger.update({ status: 'FAILED', reference: reason || ledger.reference }, { transaction });
    const reversalLedger = await db.Transaction.create({
      memberId: ledger.memberId,
      loanId: ledger.loanId,
      type: 'LOAN_REPAYMENT',
      amount: -Math.abs(Number(ledger.amount || 0)),
      method: ledger.method || 'MANUAL',
      status: 'SUCCESS',
      reference: `REVERSAL-${ledger.id}`.slice(0, 255),
      description: reason || 'Loan repayment reversal',
      paymentCategory: 'loan_repayment_reversal',
    }, { transaction });
    await db.FinancialLedgerEntry.bulkCreate([
      {
        transactionId: reversalLedger.id,
        loanId: ledger.loanId,
        memberId: ledger.memberId,
        account: 'CASH',
        side: 'CREDIT',
        amount: Math.abs(Number(ledger.amount || 0)),
        memo: reason || 'Loan repayment cash reversal',
      },
      {
        transactionId: reversalLedger.id,
        loanId: ledger.loanId,
        memberId: ledger.memberId,
        account: 'LOAN_RECEIVABLE',
        side: 'DEBIT',
        amount: Number(repayment.principalPaid || 0),
        memo: reason || 'Loan principal reversal',
      },
      {
        transactionId: reversalLedger.id,
        loanId: ledger.loanId,
        memberId: ledger.memberId,
        account: 'INTEREST_INCOME',
        side: 'DEBIT',
        amount: Number(repayment.interestPaid || 0),
        memo: reason || 'Loan interest reversal',
      },
    ].filter((entry) => Number(entry.amount || 0) > 0), { transaction });
    repayment.metadata = {
      ...(repayment.metadata || {}),
      voided: true,
      voided_by_id: voidedById || null,
      void_reason: reason || null,
      voided_at: new Date().toISOString(),
    };
    await repayment.save({ transaction });
    return { ledger, repayment };
  })
);

module.exports = {
  allocateLedgerRepayment,
  allocateMpesaRepayment,
  postLoanPayment,
  postManualRepayment,
  voidRepayment,
};
