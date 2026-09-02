const crypto = require('crypto');
const db = require('../../../models');
const { Op } = require('sequelize');
const { ValidationError, NotFoundError } = require('../../../shared/utils/errors');

const FEE_RATE = 0.05;
const DEFAULT_MINIMUM = 20000;

async function accountBalance(memberId, transaction) {
  const account = await db.ShareAccount.findOne({ where: { memberId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!account) throw new NotFoundError('Share capital account not found');
  return { account, balance: Number(account.shares || 0) * Number(account.shareValue || 0) };
}

async function transfer({ senderMemberId, recipientMemberNumber, amount, optOut = false }) {
  const grossAmount = Number(amount);
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) throw new ValidationError('Enter a valid transfer amount');

  return db.sequelize.transaction(async (transaction) => {
    const [sender, recipient, config] = await Promise.all([
      db.Member.findByPk(senderMemberId, { transaction, lock: transaction.LOCK.UPDATE }),
      db.Member.findOne({ where: { memberNumber: String(recipientMemberNumber || '').trim().toUpperCase(), status: 'ACTIVE' }, transaction, lock: transaction.LOCK.UPDATE }),
      db.SystemConfig.findOne({ transaction }),
    ]);
    if (!sender) throw new NotFoundError('Sender member profile not found');
    if (!recipient) throw new NotFoundError('Active recipient member not found');
    if (sender.id === recipient.id) throw new ValidationError('You cannot transfer share capital to yourself');

    const senderState = await accountBalance(sender.id, transaction);
    const recipientState = await accountBalance(recipient.id, transaction);
    const minimum = Number(config?.shareCapital || DEFAULT_MINIMUM);
    if (grossAmount > senderState.balance) throw new ValidationError('Transfer amount exceeds your share capital balance');
    if (optOut && Math.abs(grossAmount - senderState.balance) > 0.01) throw new ValidationError('Opt-out transfers must transfer 100% of share capital');
    if (!optOut && senderState.balance - grossAmount < minimum) throw new ValidationError(`Remaining share capital must be at least KES ${minimum.toLocaleString()}`);

    const feeAmount = Math.round(grossAmount * FEE_RATE * 100) / 100;
    const netAmount = Math.round((grossAmount - feeAmount) * 100) / 100;
    const reference = `SCT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    senderState.account.shares = (senderState.balance - grossAmount) / Number(senderState.account.shareValue || 100);
    recipientState.account.shares = (recipientState.balance + netAmount) / Number(recipientState.account.shareValue || 100);
    await Promise.all([senderState.account.save({ transaction }), recipientState.account.save({ transaction })]);
    const record = await db.ShareCapitalTransfer.create({
      senderMemberId: sender.id, recipientMemberId: recipient.id, grossAmount, feeAmount, netAmount,
      transferType: optOut ? 'OPT_OUT' : 'STANDARD', reference,
      metadata: { feeRate: FEE_RATE, minimumShareCapital: minimum, revenuePool: 'GENERAL_REVENUE' },
    }, { transaction });
    return { ...record.toJSON(), senderMemberNumber: sender.memberNumber, recipientMemberNumber: recipient.memberNumber };
  });
}

async function historyForMember(memberId) {
  return db.ShareCapitalTransfer.findAll({
    where: { [Op.or]: [{ senderMemberId: memberId }, { recipientMemberId: memberId }] },
    include: [
      { model: db.Member, as: 'sender', attributes: ['memberNumber'] },
      { model: db.Member, as: 'recipient', attributes: ['memberNumber'] },
    ], order: [['createdAt', 'DESC']],
  });
}

module.exports = { transfer, historyForMember, FEE_RATE };
