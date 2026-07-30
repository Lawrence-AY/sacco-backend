const { Op } = require('sequelize');
const db = require('../../../models');
const { ForbiddenError, ValidationError } = require('../../../shared/utils/errors');

const STAFF_ROLES = ['ADMIN', 'FINANCE', 'SUPERADMIN'];
const SEARCH_TYPES = [
  'members',
  'transactions',
  'loans',
  'applications',
  'savingsAccounts',
  'shareAccounts',
  'dividends',
  'salaryDeductions',
];

const isStaff = (user) => STAFF_ROLES.includes(String(user?.role || '').toUpperCase());
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const escapeLike = (value) => String(value).replace(/[\\%_]/g, '\\$&');
const compact = (items) => items.filter(Boolean);

const getMemberScope = async (user) => {
  if (isStaff(user)) return null;
  const member = await db.Member.findOne({ where: { userId: user.id }, attributes: ['id'] });
  if (!member) return { id: null };
  return { id: member.id };
};

const buildPagination = ({ page, limit }) => {
  const safeLimit = Math.min(Number(limit) || 10, 50);
  const safePage = Math.max(Number(page) || 1, 1);
  return {
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
    page: safePage,
  };
};

const buildOrder = (sortBy, sortOrder, allowed = ['createdAt', 'updatedAt']) => {
  const column = allowed.includes(sortBy) ? sortBy : 'createdAt';
  return [[column, sortOrder === 'ASC' ? 'ASC' : 'DESC']];
};

const memberInclude = (like) => ({
  model: db.User,
  attributes: ['id', 'firstName', 'lastName', 'name', 'email', 'phone', 'role'],
  required: true,
  where: {
    [Op.or]: [
      { firstName: { [Op.iLike]: like } },
      { lastName: { [Op.iLike]: like } },
      { name: { [Op.iLike]: like } },
      { email: { [Op.iLike]: like } },
      { phone: { [Op.iLike]: like } },
      { nationalId: { [Op.iLike]: like } },
    ],
  },
});

const memberOwnerInclude = (like) => ({
  model: db.Member,
  attributes: ['id', 'memberNumber', 'nationalId'],
  required: true,
  include: [memberInclude(like)],
});

const serializeMember = (member) => ({
  id: member.id,
  memberNumber: member.memberNumber,
  nationalId: member.nationalId,
  type: member.type,
  isVerified: member.isVerified,
  createdAt: member.createdAt,
  user: member.User ? {
    id: member.User.id,
    name: member.User.name || `${member.User.firstName || ''} ${member.User.lastName || ''}`.trim(),
    email: member.User.email,
    phone: member.User.phone,
    role: member.User.role,
  } : null,
});

const findMemberByNumber = async (memberNumber) => {
  const normalized = String(memberNumber || '').trim().toUpperCase();
  if (!normalized) throw new ValidationError('Member number is required');

  const member = await db.Member.findOne({
    where: { memberNumber: normalized },
    include: [{
      model: db.User,
      attributes: ['id', 'firstName', 'lastName', 'name', 'email', 'phone', 'role', 'address', 'occupation'],
      required: false,
    }],
  });
  return member ? {
    ...serializeMember(member),
    status: member.status || (member.isVerified ? 'ACTIVE' : 'PENDING'),
    dateJoined: member.dateJoined || member.createdAt,
    applicationId: member.applicationId || null,
    paymentReference: member.paymentReference || null,
  } : null;
};

const serializeTransaction = (transaction) => ({
  id: transaction.id,
  memberId: transaction.memberId,
  loanId: transaction.loanId,
  type: transaction.type,
  amount: transaction.amount,
  method: transaction.method,
  status: transaction.status,
  reference: transaction.reference,
  paymentCategory: transaction.paymentCategory,
  kcbEndpoint: transaction.kcbEndpoint,
  internalReference: transaction.internalReference,
  promptChannel: transaction.promptChannel,
  createdAt: transaction.createdAt,
  memberNumber: transaction.Member?.memberNumber || null,
});

const serializeLoan = (loan) => ({
  id: loan.id,
  memberId: loan.memberId,
  amount: loan.amount,
  type: loan.type,
  status: loan.status,
  approvalStage: loan.approvalStage,
  createdAt: loan.createdAt,
  memberNumber: loan.Member?.memberNumber || null,
});

const serializeApplication = (application) => ({
  id: application.id,
  name: application.name,
  email: application.email,
  phone: application.phone,
  nationalId: application.nationalId,
  status: application.status,
  paymentReference: application.paymentReference,
  createdAt: application.createdAt,
});

const searchMembers = async ({ like, exactId, memberScope, pagination, sortBy, sortOrder }) => {
  const where = {
    ...(memberScope || {}),
    [Op.or]: compact([
      { memberNumber: { [Op.iLike]: like } },
      { nationalId: { [Op.iLike]: like } },
      { '$User.firstName$': { [Op.iLike]: like } },
      { '$User.lastName$': { [Op.iLike]: like } },
      { '$User.name$': { [Op.iLike]: like } },
      { '$User.email$': { [Op.iLike]: like } },
      { '$User.phone$': { [Op.iLike]: like } },
      { '$User.nationalId$': { [Op.iLike]: like } },
      exactId ? { id: exactId } : null,
    ]),
  };

  const rows = await db.Member.findAll({
    where,
    include: [{
      model: db.User,
      attributes: ['id', 'firstName', 'lastName', 'name', 'email', 'phone', 'role'],
      required: false,
    }],
    limit: pagination.limit,
    offset: pagination.offset,
    order: sortBy === 'name'
      ? [[db.User, 'name', sortOrder === 'ASC' ? 'ASC' : 'DESC']]
      : buildOrder(sortBy, sortOrder),
    subQuery: false,
  });
  return rows.map(serializeMember);
};

const searchTransactions = async ({ like, exactId, memberScope, pagination, sortBy, sortOrder, status }) => {
  const rows = await db.Transaction.findAll({
    where: {
      ...(memberScope?.id ? { memberId: memberScope.id } : {}),
      ...(status ? { status } : {}),
      [Op.or]: compact([
        { reference: { [Op.iLike]: like } },
        { type: { [Op.iLike]: like } },
        { method: { [Op.iLike]: like } },
        exactId ? { id: exactId } : null,
        exactId ? { loanId: exactId } : null,
      ]),
    },
    include: [{ model: db.Member, attributes: ['id', 'memberNumber'], required: false }],
    limit: pagination.limit,
    offset: pagination.offset,
    order: buildOrder(sortBy, sortOrder, ['createdAt', 'updatedAt', 'amount', 'status']),
  });
  return rows.map(serializeTransaction);
};

const searchLoans = async ({ like, exactId, memberScope, pagination, sortBy, sortOrder, status }) => {
  const rows = await db.Loan.findAll({
    where: {
      ...(memberScope?.id ? { memberId: memberScope.id } : {}),
      ...(status ? { status } : {}),
      [Op.or]: compact([
        { type: { [Op.iLike]: like } },
        { status: { [Op.iLike]: like } },
        { approvalStage: { [Op.iLike]: like } },
        exactId ? { id: exactId } : null,
      ]),
    },
    include: [{ model: db.Member, attributes: ['id', 'memberNumber'], required: false }],
    limit: pagination.limit,
    offset: pagination.offset,
    order: buildOrder(sortBy, sortOrder, ['createdAt', 'updatedAt', 'amount', 'status']),
  });
  return rows.map(serializeLoan);
};

const searchApplications = async ({ like, exactId, pagination, sortBy, sortOrder, status }) => {
  const rows = await db.MembershipApplication.findAll({
    where: {
      ...(status ? { status } : {}),
      [Op.or]: compact([
        { name: { [Op.iLike]: like } },
        { nationalId: { [Op.iLike]: like } },
        { phone: { [Op.iLike]: like } },
        { email: { [Op.iLike]: like } },
        { paymentReference: { [Op.iLike]: like } },
        exactId ? { id: exactId } : null,
      ]),
    },
    limit: pagination.limit,
    offset: pagination.offset,
    order: buildOrder(sortBy, sortOrder, ['createdAt', 'updatedAt', 'status', 'name']),
  });
  return rows.map(serializeApplication);
};

const searchMemberOwned = async ({ model, like, memberScope, pagination, sortBy, sortOrder, status }) => {
  const rows = await model.findAll({
    where: {
      ...(memberScope?.id ? { memberId: memberScope.id } : {}),
      ...(status && model === db.SalaryDeduction ? { isActive: status === 'ACTIVE' } : {}),
    },
    include: [memberOwnerInclude(like)],
    limit: pagination.limit,
    offset: pagination.offset,
    order: buildOrder(sortBy, sortOrder),
  });

  return rows.map((row) => ({
    id: row.id,
    memberId: row.memberId,
    balance: row.balance,
    shares: row.shares,
    shareValue: row.shareValue,
    year: row.year,
    amount: row.amount,
    shareAmount: row.shareAmount,
    contribution: row.contribution,
    startDate: row.startDate,
    isActive: row.isActive,
    createdAt: row.createdAt,
    memberNumber: row.Member?.memberNumber || null,
  }));
};

const searchAll = async (query, user) => {
  if (!user) {
    throw new ForbiddenError('Authentication is required to search');
  }

  const q = String(query.q || '').trim();
  if (q.length < 2) {
    throw new ValidationError('Search query must be at least 2 characters');
  }

  const pagination = buildPagination(query);
  const exactId = isUuid(q) ? q : null;
  const like = `%${escapeLike(q)}%`;
  const memberScope = await getMemberScope(user);
  const requestedTypes = query.type === 'all' ? SEARCH_TYPES : [query.type];
  const canSearchApplications = isStaff(user);
  const tasks = {};

  if (requestedTypes.includes('members')) tasks.members = searchMembers({ like, exactId, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder });
  if (requestedTypes.includes('transactions')) tasks.transactions = searchTransactions({ like, exactId, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder, status: query.status });
  if (requestedTypes.includes('loans')) tasks.loans = searchLoans({ like, exactId, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder, status: query.status });
  if (requestedTypes.includes('applications') && canSearchApplications) tasks.applications = searchApplications({ like, exactId, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder, status: query.status });
  if (requestedTypes.includes('savingsAccounts')) tasks.savingsAccounts = searchMemberOwned({ model: db.SavingsAccount, like, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder });
  if (requestedTypes.includes('shareAccounts')) tasks.shareAccounts = searchMemberOwned({ model: db.ShareAccount, like, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder });
  if (requestedTypes.includes('dividends')) tasks.dividends = searchMemberOwned({ model: db.Dividend, like, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder });
  if (requestedTypes.includes('salaryDeductions')) tasks.salaryDeductions = searchMemberOwned({ model: db.SalaryDeduction, like, memberScope, pagination, sortBy: query.sortBy, sortOrder: query.sortOrder, status: query.status });

  const entries = await Promise.all(Object.entries(tasks).map(async ([key, task]) => [key, await task]));
  const results = Object.fromEntries(entries);

  return {
    members: results.members || [],
    transactions: results.transactions || [],
    loans: results.loans || [],
    applications: results.applications || [],
    savingsAccounts: results.savingsAccounts || [],
    shareAccounts: results.shareAccounts || [],
    dividends: results.dividends || [],
    salaryDeductions: results.salaryDeductions || [],
    meta: {
      q,
      type: query.type,
      page: pagination.page,
      limit: pagination.limit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      role: user.role,
      futureSearchBackends: ['postgres_ilike', 'postgres_full_text', 'elasticsearch'],
    },
  };
};

module.exports = {
  searchAll,
  findMemberByNumber,
};
