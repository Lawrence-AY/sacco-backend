const db = require('../../../models');

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const addMonths = (value, months) => {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date;
};

const allocateMpesaRepayment = async ({ ledgerTransactionId, receipt, confirmedAmount, resultDescription }) => (
  db.sequelize.transaction(async (transaction) => {
    const ledger = await db.Transaction.findByPk(ledgerTransactionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ledger) return null;
    const existing = await db.LoanTransaction.findOne({ where: { ledgerTransactionId: ledger.id }, transaction });
    if (existing) return { ledger, repayment: existing, duplicate: true };

    const loan = await db.Loan.findByPk(ledger.loanId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) throw new Error('Loan linked to M-Pesa repayment was not found');
    const amount = roundMoney(confirmedAmount ?? ledger.amount);
    const principal = Number(loan.principalBalance ?? loan.amount ?? 0);
    const paymentDate = new Date();
    const accrualStart = new Date(loan.lastInterestAccrualAt || loan.decidedAt || loan.createdAt);
    const accruedDays = Math.max(0, Math.floor((paymentDate - accrualStart) / 86400000));
    const accruedInterest = roundMoney(Number(loan.accruedInterest || 0) + principal * (Number(loan.interestRate || 0) / 100 / 30) * accruedDays);
    const outstanding = roundMoney(principal + accruedInterest);
    if (amount <= 0 || amount > outstanding) throw new Error(`Confirmed M-Pesa amount exceeds outstanding balance of KES ${outstanding.toFixed(2)}`);

    const interestPaid = Math.min(amount, accruedInterest);
    const principalPaid = Math.min(amount - interestPaid, principal);
    const remainingPrincipal = roundMoney(principal - principalPaid);
    const remainingInterest = roundMoney(accruedInterest - interestPaid);
    const start = new Date(loan.decidedAt || loan.createdAt);
    const elapsedMonths = Math.max(0, (paymentDate.getUTCFullYear() - start.getUTCFullYear()) * 12 + paymentDate.getUTCMonth() - start.getUTCMonth());
    const nextPaymentDueAt = remainingPrincipal || remainingInterest ? addMonths(start, elapsedMonths + 1) : null;

    await ledger.update({ status: 'SUCCESS', amount, reference: receipt || ledger.reference, description: resultDescription || 'M-Pesa loan repayment received' }, { transaction });
    const repayment = await db.LoanTransaction.create({
      loanId: loan.id, memberId: loan.memberId, ledgerTransactionId: ledger.id,
      transactionType: 'INTERIM_PAYMENT', amount, principalPaid, interestPaid, remainingPrincipal, accruedDays,
      metadata: {
        mpesa_receipt_number: receipt || null,
        principal_paid: principalPaid,
        interest_paid: interestPaid,
        remaining_interest: remainingInterest,
        remaining_balance: roundMoney(remainingPrincipal + remainingInterest),
        payment_channel: 'MPESA_STK',
      },
    }, { transaction });
    await loan.update({
      principalBalance: remainingPrincipal, accruedInterest: remainingInterest,
      lastInterestAccrualAt: paymentDate, nextPaymentDueAt,
      status: remainingPrincipal === 0 && remainingInterest === 0 ? 'COMPLETED' : loan.status,
    }, { transaction });
    return { ledger, repayment, duplicate: false };
  })
);

module.exports = { allocateMpesaRepayment };
