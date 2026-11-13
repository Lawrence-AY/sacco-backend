const db = require('../../../models');

const { Op } = db.Sequelize;
const OPEN_APPLICATION_STATUSES = ['PENDING', 'PENDING_GUARANTORS', 'FULLY_COVERED', 'UNDER_REVIEW'];
const OUTSTANDING_LOAN_STATUSES = ['ACTIVE', 'DISBURSED', 'OVERDUE', 'IN_ARREARS', 'DEFAULTED'];
const CAPACITY_LOAN_STATUSES = [...OPEN_APPLICATION_STATUSES, 'APPROVED', ...OUTSTANDING_LOAN_STATUSES];
const SELF_GUARANTEE_MULTIPLIER = Math.max(0, Number(process.env.SELF_GUARANTEE_SAVINGS_MULTIPLIER || 1));
const PLEDGE_HOLD_STATUSES = ['PENDING', 'ACCEPTED'];
const LIVE_PLEDGE_LOAN_STATUSES = [...OPEN_APPLICATION_STATUSES, 'APPROVED', ...OUTSTANDING_LOAN_STATUSES];
const EXIT_BLOCKING_STATUSES = ['PENDING', 'APPROVED', 'DISBURSED'];
const NON_PERFORMING_LOAN_STATUSES = ['DEFAULTED', 'WRITTEN_OFF', 'IN_ARREARS'];

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const openLoanBalance = (loan) => Math.max(
  0,
  Number(loan?.principalBalance ?? loan?.amount ?? 0) + Number(loan?.accruedInterest || 0),
);

const outstandingObligationsForLoans = (loans = []) => money(loans.reduce((sum, loan) => (
  OUTSTANDING_LOAN_STATUSES.includes(String(loan.status || '').toUpperCase())
    ? sum + openLoanBalance(loan)
    : sum
), 0));

const selfGuaranteeHoldForLoan = (loan) => {
  if (!loan?.selfGuaranteed || String(loan.disbursementStatus || '').toUpperCase() === 'DENIED') return 0;
  const status = String(loan.status || '').toUpperCase();
  if (!CAPACITY_LOAN_STATUSES.includes(status)) return 0;
  if (OPEN_APPLICATION_STATUSES.includes(status)) return money(loan.selfGuaranteedAmount || 0);
  return money(Math.min(Number(loan.selfGuaranteedAmount || 0), openLoanBalance(loan)));
};

const pledgeHoldForLoan = (pledge, loan) => {
  if (!pledge || !loan) return 0;
  const status = String(loan.status || '').toUpperCase();
  const pledgeStatus = String(pledge.status || '').toUpperCase();
  if (!PLEDGE_HOLD_STATUSES.includes(pledgeStatus)
    || !LIVE_PLEDGE_LOAN_STATUSES.includes(status)
    || String(loan.disbursementStatus || '').toUpperCase() === 'DENIED') return 0;
  return money(pledge.amount || 0);
};

const calculateCapacity = ({ totalSavings, pledgeHolds = 0, selfGuaranteeHolds = 0 }) => {
  const committedCapacity = money(Number(pledgeHolds || 0) + Number(selfGuaranteeHolds || 0));
  const availableSavings = money(Math.max(0, Number(totalSavings || 0) * SELF_GUARANTEE_MULTIPLIER - committedCapacity));
  return { committedCapacity, freeSavings: availableSavings };
};

const calculateGuaranteeProgress = ({ loanAmount, selfGuaranteedAmount = 0, pledges = [] }) => {
  const acceptedPledges = money(pledges
    .filter((pledge) => String(pledge.status || '').toUpperCase() === 'ACCEPTED')
    .reduce((sum, pledge) => sum + Number(pledge.amount || 0), 0));
  const pendingPledges = money(pledges
    .filter((pledge) => String(pledge.status || '').toUpperCase() === 'PENDING')
    .reduce((sum, pledge) => sum + Number(pledge.amount || 0), 0));
  const requiredAmount = money(loanAmount);
  const selfGuarantee = money(selfGuaranteedAmount);
  const fullyGuaranteed = money(selfGuarantee + acceptedPledges) >= requiredAmount;
  return {
    acceptedPledges,
    pendingPledges,
    selfGuaranteedAmount: selfGuarantee,
    totalGuaranteed: money(selfGuarantee + acceptedPledges),
    totalRequested: money(selfGuarantee + acceptedPledges + pendingPledges),
    remainingToGuarantee: money(Math.max(0, requiredAmount - selfGuarantee - acceptedPledges)),
    fullyGuaranteed,
  };
};

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
    where: { memberId, status: { [Op.in]: OUTSTANDING_LOAN_STATUSES } },
    attributes: ['amount', 'principalBalance', 'accruedInterest', 'status'],
    transaction: options.transaction,
    lock: options.lock,
  });
  return outstandingObligationsForLoans(loans);
};

const getPledgeHolds = async (memberId, options = {}) => {
  const pledges = await db.Guarantor.findAll({
    where: {
    memberId,
    status: { [Op.in]: PLEDGE_HOLD_STATUSES },
    ...(options.excludeGuarantorId ? { id: { [Op.ne]: options.excludeGuarantorId } } : {}),
    },
    attributes: ['loanId', 'amount', 'status'],
    transaction: options.transaction,
    lock: options.lock,
  });
  const loanIds = [...new Set(pledges.map((pledge) => pledge.loanId).filter(Boolean))];
  const loans = await Promise.all(loanIds.map((id) => db.Loan.findByPk(id, {
    attributes: ['status', 'disbursementStatus'],
    transaction: options.transaction,
    lock: options.lock,
  })));
  const statusesByLoan = new Map(loanIds.map((id, index) => [id, {
    status: String(loans[index]?.status || '').toUpperCase(),
    disbursementStatus: String(loans[index]?.disbursementStatus || '').toUpperCase(),
  }]));
  return money(pledges.reduce((sum, pledge) => sum + pledgeHoldForLoan(pledge, statusesByLoan.get(pledge.loanId)), 0));
};

const getSelfGuaranteeHolds = async (memberId, options = {}) => {
  const loans = await db.Loan.findAll({
    where: { memberId, selfGuaranteed: true, status: { [Op.in]: CAPACITY_LOAN_STATUSES } },
    attributes: ['amount', 'principalBalance', 'accruedInterest', 'selfGuaranteedAmount', 'status', 'disbursementStatus'],
    transaction: options.transaction,
    lock: options.lock,
  });
  return money(loans.reduce((sum, loan) => sum + selfGuaranteeHoldForLoan(loan), 0));
};

const getMemberCapacity = async (memberId, options = {}) => {
  const member = await db.Member.findByPk(memberId, { transaction: options.transaction, lock: options.lock });
  if (!member) return null;
  const [totalSavings, outstandingLoans, pledgeHolds, selfGuaranteeHolds, exitRequest, defaultedLoan] = await Promise.all([
    getTotalSavings(memberId, options),
    getOutstandingLoans(memberId, options),
    getPledgeHolds(memberId, options),
    getSelfGuaranteeHolds(memberId, options),
    db.MemberExitRequest.findOne({ where: { memberId, status: { [Op.in]: EXIT_BLOCKING_STATUSES } }, transaction: options.transaction }),
    db.Loan.findOne({ where: { memberId, status: { [Op.in]: NON_PERFORMING_LOAN_STATUSES } }, transaction: options.transaction }),
  ]);
  const { committedCapacity, freeSavings } = calculateCapacity({ totalSavings, pledgeHolds, selfGuaranteeHolds });
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
    selfGuaranteeHolds,
    guaranteeMultiplier: SELF_GUARANTEE_MULTIPLIER,
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
  const loanStatus = String(loan.status || '').toUpperCase();
  const closed = ['COMPLETED', 'CLOSED', 'PAID', 'REJECTED', 'CANCELLED', 'WRITTEN_OFF'].includes(loanStatus)
    || String(loan.disbursementStatus || '').toUpperCase() === 'DENIED';
  const progress = calculateGuaranteeProgress({
    loanAmount: loan.amount,
    selfGuaranteedAmount: loan.selfGuaranteedAmount,
    pledges: closed ? [] : pledges,
  });
  return {
    loan,
    pledges,
    ...progress,
    remainingNeeded: closed ? 0 : money(Math.max(0, Number(loan.amount || 0) - progress.selfGuaranteedAmount - progress.acceptedPledges - progress.pendingPledges)),
    acceptedRemaining: closed ? 0 : progress.remainingToGuarantee,
    fullyGuaranteed: !closed && progress.fullyGuaranteed,
  };
};

module.exports = {
  getMemberCapacity,
  getLoanCoverage,
  money,
  openLoanBalance,
  outstandingObligationsForLoans,
  selfGuaranteeHoldForLoan,
  pledgeHoldForLoan,
  calculateCapacity,
  calculateGuaranteeProgress,
  OUTSTANDING_LOAN_STATUSES,
};
