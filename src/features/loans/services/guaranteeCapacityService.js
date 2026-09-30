const db = require('../../../models');

const { Op } = db.Sequelize;
const CAPACITY_LOAN_STATUSES = ['PENDING', 'PENDING_GUARANTORS', 'FULLY_COVERED', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'DISBURSED', 'IN_ARREARS', 'DEFAULTED'];
const PLEDGE_HOLD_STATUSES = ['PENDING', 'ACCEPTED'];
const EXIT_BLOCKING_STATUSES = ['PENDING', 'APPROVED', 'DISBURSED'];
const NON_PERFORMING_LOAN_STATUSES = ['DEFAULTED', 'WRITTEN_OFF', 'IN_ARREARS'];

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const getTotalSavings = async (memberId, options = {}) => {
  const [account, transactions] = await Promise.all([
    db.SavingsAccount.findOne({ where: { memberId }, transaction: options.transaction, lock: options.lock }),
    db.Transaction.findAll({ where: { memberId, status: 'SUCCESS' }, transaction: options.transaction }),
  ]);
  const ledgerSavings = transactions.reduce((sum, entry) => {
    const category = String(entry.paymentCategory || entry.kcbEndpoint || entry.description || entry.type || '').toLowerCase();
    const type = String(entry.type || '').toUpperCase();
    if (category.includes('savings') && (type.includes('WITHDRAW') || category.includes('withdraw'))) return sum - Number(entry.amount || 0);
    return category.includes('savings') ? sum + Number(entry.amount || 0) : sum;
  }, 0);
  return money(Math.max(0, account ? Number(account.balance || 0) : ledgerSavings));
};

const getOutstandingLoans = async (memberId, options = {}) => {
  const loans = await db.Loan.findAll({
    where: { memberId, status: { [Op.in]: CAPACITY_LOAN_STATUSES } },
    attributes: ['amount', 'principalBalance', 'status'],
    transaction: options.transaction,
    lock: options.lock,
  });
  return money(loans.reduce((sum, loan) => sum + Number(loan.principalBalance ?? loan.amount ?? 0), 0));
};

const getPledgeHolds = async (memberId, options = {}) => money(await db.Guarantor.sum('amount', {
  where: {
    memberId,
    status: { [Op.in]: PLEDGE_HOLD_STATUSES },
    ...(options.excludeGuarantorId ? { id: { [Op.ne]: options.excludeGuarantorId } } : {}),
  },
  transaction: options.transaction,
}) || 0);

const getMemberCapacity = async (memberId, options = {}) => {
  const member = await db.Member.findByPk(memberId, { transaction: options.transaction, lock: options.lock });
  if (!member) return null;
  const [totalSavings, outstandingLoans, pledgeHolds, exitRequest, defaultedLoan] = await Promise.all([
    getTotalSavings(memberId, options),
    getOutstandingLoans(memberId, options),
    getPledgeHolds(memberId, options),
    db.MemberExitRequest.findOne({ where: { memberId, status: { [Op.in]: EXIT_BLOCKING_STATUSES } }, transaction: options.transaction }),
    db.Loan.findOne({ where: { memberId, status: { [Op.in]: NON_PERFORMING_LOAN_STATUSES } }, transaction: options.transaction }),
  ]);
  const committedCapacity = money(outstandingLoans + pledgeHolds);
  const freeSavings = money(Math.max(0, totalSavings - committedCapacity));
  const memberActive = String(member.status || '').toUpperCase() === 'ACTIVE';
  const reason = !memberActive
    ? 'Member account is not active'
    : exitRequest ? 'Member has an active exit request'
      : defaultedLoan ? 'Member has a non-performing loan'
        : freeSavings <= 0 ? 'No free savings available' : null;
  return {
    member,
    totalSavings,
    outstandingLoans,
    pledgeHolds,
    committedCapacity,
    freeSavings,
    isEligibleToGuarantee: !reason,
    ineligibilityReason: reason,
  };
};

const getLoanCoverage = async (loanId, options = {}) => {
  const loan = await db.Loan.findByPk(loanId, { transaction: options.transaction, lock: options.lock });
  if (!loan) return null;
  const pledges = await db.Guarantor.findAll({ where: { loanId }, transaction: options.transaction, lock: options.lock });
  const acceptedPledges = money(pledges.filter((item) => item.status === 'ACCEPTED').reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const pendingPledges = money(pledges.filter((item) => item.status === 'PENDING').reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const selfGuaranteedAmount = money(loan.selfGuaranteedAmount || 0);
  return {
    loan,
    pledges,
    selfGuaranteedAmount,
    acceptedPledges,
    pendingPledges,
    remainingNeeded: money(Math.max(0, Number(loan.amount || 0) - selfGuaranteedAmount - acceptedPledges - pendingPledges)),
    acceptedRemaining: money(Math.max(0, Number(loan.amount || 0) - selfGuaranteedAmount - acceptedPledges)),
  };
};

module.exports = { getMemberCapacity, getLoanCoverage, money };
