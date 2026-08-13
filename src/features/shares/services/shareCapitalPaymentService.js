const db = require('../../../models');

const isShareCapitalPayment = (transaction) => {
  const category = String(transaction?.paymentCategory || '').toLowerCase();
  return category === 'share_capital' || category === 'sharecapital';
};

// Settles the ledger row and share account in one locked transaction. Replayed
// M-Pesa callbacks see the already-successful row and cannot credit shares twice.
const settleShareCapitalPayment = async ({ transactionId, receipt, amount, description }) => (
  db.sequelize.transaction(async (databaseTransaction) => {
    const payment = await db.Transaction.findByPk(transactionId, {
      transaction: databaseTransaction,
      lock: databaseTransaction.LOCK.UPDATE,
    });
    if (!payment || !isShareCapitalPayment(payment)) return payment;
    if (String(payment.status || '').toUpperCase() === 'SUCCESS') return payment;

    const paidAmount = Number(amount ?? payment.amount ?? 0);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0) throw new Error('Share capital payment amount is invalid');

    const [account] = await db.ShareAccount.findOrCreate({
      where: { memberId: payment.memberId },
      defaults: { memberId: payment.memberId, shares: 0, shareValue: 100 },
      transaction: databaseTransaction,
    });
    const shareValue = Number(account.shareValue || 100);
    await account.update({ shares: Number(account.shares || 0) + (paidAmount / shareValue) }, { transaction: databaseTransaction });
    await payment.update({
      status: 'SUCCESS',
      reference: receipt || payment.reference,
      amount: paidAmount,
      description: description || payment.description,
    }, { transaction: databaseTransaction });
    return payment;
  })
);

module.exports = { isShareCapitalPayment, settleShareCapitalPayment };
