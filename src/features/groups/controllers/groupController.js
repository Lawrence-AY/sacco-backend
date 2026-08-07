const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../../models');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../../shared/utils/errors');

const memberForUser = (userId) => db.Member.findOne({ where: { userId } });

async function financialEligibility(memberId) {
  const [account, config, transactions, loans] = await Promise.all([
    db.ShareAccount.findOne({ where: { memberId } }), db.SystemConfig.findOne(),
    db.Transaction.findAll({ where: { memberId, status: 'SUCCESS' } }),
    db.Loan.findAll({ where: { memberId, status: { [Op.in]: ['APPROVED', 'ACTIVE'] } } }),
  ]);
  const accountCapital = Number(account?.shares || 0) * Number(account?.shareValue || 0);
  const paidCapital = transactions.reduce((sum, row) => String(row.paymentCategory || row.description || '').toLowerCase().includes('share') ? sum + Number(row.amount || 0) : sum, 0);
  const repayments = transactions.reduce((map, row) => {
    if (row.type === 'LOAN_REPAYMENT' && row.loanId) map.set(row.loanId, (map.get(row.loanId) || 0) + Number(row.amount || 0));
    return map;
  }, new Map());
  const outstandingLoans = loans.reduce((sum, loan) => sum + Math.max(Number(loan.amount || 0) - (repayments.get(loan.id) || 0), 0), 0);
  const minimumShareCapital = Number(config?.shareCapital || 25000);
  const shareCapital = Math.max(accountCapital, paidCapital);
  return { eligible: shareCapital >= minimumShareCapital && outstandingLoans <= 0, shareCapital, minimumShareCapital, outstandingLoans };
}

const memberInclude = { model: db.Member, as: 'member', attributes: ['id', 'memberNumber', 'userId'], include: [{ model: db.User, attributes: ['name', 'email', 'phone'] }] };
const groupInclude = [
  { model: db.Member, as: 'creator', attributes: ['id', 'memberNumber'], include: [{ model: db.User, attributes: ['name'] }] },
  { model: db.GroupMembership, as: 'memberships', include: [memberInclude] },
  { model: db.GroupLoan, as: 'loans' }, { model: db.GroupTransaction, as: 'transactions' },
];

const serializeGroup = (group, viewerMemberId) => {
  const row = group.toJSON();
  const viewerMembership = row.memberships?.find((item) => item.memberId === viewerMemberId);
  return { ...row, isCreator: row.creatorMemberId === viewerMemberId, viewerMembershipId: viewerMembership?.id || null, viewerStatus: viewerMembership?.status || null,
    members: (row.memberships || []).map((item) => ({ id: item.id, memberId: item.memberId, memberNumber: item.member?.memberNumber,
      name: item.member?.User?.name || item.member?.memberNumber, email: item.member?.User?.email, phone: item.member?.User?.phone,
      role: item.role, status: item.status, joinedAt: item.respondedAt || item.createdAt })) };
};

async function visibleGroup(groupId, memberId) {
  const membership = await db.GroupMembership.findOne({ where: { groupId, memberId, status: { [Op.in]: ['PENDING', 'ACCEPTED'] } } });
  if (!membership) throw new ForbiddenError('You do not have access to this group');
  const group = await db.BorrowingGroup.findByPk(groupId, { include: groupInclude });
  if (!group) throw new NotFoundError('Group not found');
  return { group, membership };
}

const listGroups = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id);
  if (!member) return ResponseHandler.success(res, { eligibility: null, groups: [] });
  const memberships = await db.GroupMembership.findAll({ where: { memberId: member.id, status: { [Op.in]: ['PENDING', 'ACCEPTED'] } }, attributes: ['groupId'] });
  const groups = memberships.length ? await db.BorrowingGroup.findAll({ where: { id: { [Op.in]: memberships.map((item) => item.groupId) } }, include: groupInclude, order: [['updatedAt', 'DESC']] }) : [];
  return ResponseHandler.success(res, { eligibility: await financialEligibility(member.id), groups: groups.map((group) => serializeGroup(group, member.id)) }, 'Groups retrieved successfully');
});

const createGroup = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');
  const eligibility = await financialEligibility(member.id);
  if (!eligibility.eligible) throw new ForbiddenError('Complete minimum share capital and clear outstanding loans before creating a borrowing group');
  const group = await db.sequelize.transaction(async (transaction) => {
    const created = await db.BorrowingGroup.create({ name: req.body.name.trim(), description: req.body.description || null, creatorMemberId: member.id }, { transaction });
    await db.GroupMembership.create({ groupId: created.id, memberId: member.id, role: 'CREATOR', status: 'ACCEPTED', invitedByMemberId: member.id, respondedAt: new Date() }, { transaction });
    return created;
  });
  const loaded = await db.BorrowingGroup.findByPk(group.id, { include: groupInclude });
  return ResponseHandler.created(res, serializeGroup(loaded, member.id), 'Group created successfully');
});

const searchEligibleMembers = asyncHandler(async (req, res) => {
  const viewer = await memberForUser(req.user.id); const q = String(req.query.q || '').trim();
  if (q.length < 2) throw new ValidationError('Enter at least 2 characters');
  const like = `%${q}%`;
  const members = await db.Member.findAll({ where: { id: { [Op.ne]: viewer?.id }, status: 'ACTIVE', [Op.or]: [{ memberNumber: { [Op.iLike]: like } }, { '$User.name$': { [Op.iLike]: like } }] }, include: [{ model: db.User, attributes: ['name', 'email'] }], limit: 10 });
  const rows = await Promise.all(members.map(async (member) => ({ id: member.id, memberNumber: member.memberNumber, name: member.User?.name || member.memberNumber, email: member.User?.email, ...(await financialEligibility(member.id)) })));
  return ResponseHandler.success(res, rows.filter((item) => item.eligible), 'Eligible members retrieved');
});

const inviteMember = asyncHandler(async (req, res) => {
  const creator = await memberForUser(req.user.id); const group = await db.BorrowingGroup.findByPk(req.params.groupId);
  if (!group) throw new NotFoundError('Group not found');
  if (group.creatorMemberId !== creator?.id) throw new ForbiddenError('Only the group creator can add members');
  const invited = await db.Member.findOne({ where: { memberNumber: req.body.memberNumber.trim().toUpperCase(), status: 'ACTIVE' }, include: [db.User] });
  if (!invited) throw new NotFoundError('Member not found');
  if (!(await financialEligibility(invited.id)).eligible) throw new ValidationError('This member is not currently eligible for group borrowing');
  let membership = await db.GroupMembership.findOne({ where: { groupId: group.id, memberId: invited.id } });
  if (membership && ['ACCEPTED', 'PENDING'].includes(membership.status)) throw new ValidationError('Member already belongs to this group or has a pending invitation');
  if (membership) await membership.update({ status: 'PENDING', role: 'MEMBER', invitedByMemberId: creator.id, respondedAt: null });
  else membership = await db.GroupMembership.create({ groupId: group.id, memberId: invited.id, invitedByMemberId: creator.id });
  await db.Notification.create({ userId: invited.userId, eventKey: `group-invite:${membership.id}:${Date.now()}`, title: 'Group invitation', body: `${req.user.name || creator.memberNumber} invited you to join ${group.name}.`, category: 'group', severity: 'info', actionUrl: '/dashboard/user/groups', sourceType: 'GroupMembership', sourceId: membership.id, metadata: { groupId: group.id, membershipId: membership.id, actionRequired: true } });
  return ResponseHandler.created(res, membership, 'Invitation sent successfully');
});

const respondInvitation = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id);
  const membership = await db.GroupMembership.findOne({ where: { id: req.params.membershipId, groupId: req.params.groupId, memberId: member?.id, status: 'PENDING' } });
  if (!membership) throw new NotFoundError('Pending invitation not found');
  await membership.update({ status: req.body.accept ? 'ACCEPTED' : 'REJECTED', respondedAt: new Date() });
  return ResponseHandler.success(res, membership, req.body.accept ? 'Invitation accepted' : 'Invitation rejected');
});

const removeMember = asyncHandler(async (req, res) => {
  const creator = await memberForUser(req.user.id); const group = await db.BorrowingGroup.findByPk(req.params.groupId);
  if (!group) throw new NotFoundError('Group not found');
  if (group.creatorMemberId !== creator?.id) throw new ForbiddenError('Only the group creator can remove members');
  const membership = await db.GroupMembership.findOne({ where: { id: req.params.membershipId, groupId: group.id, role: 'MEMBER', status: { [Op.in]: ['PENDING', 'ACCEPTED'] } } });
  if (!membership) throw new NotFoundError('Group member not found');
  await membership.update({ status: 'REMOVED', respondedAt: new Date() });
  return ResponseHandler.success(res, membership, 'Member removed from group');
});

const leaveGroup = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id); const { group, membership } = await visibleGroup(req.params.groupId, member?.id);
  if (group.creatorMemberId === member.id) throw new ValidationError('The group creator cannot leave the group');
  if (membership.status !== 'ACCEPTED') throw new ValidationError('Only accepted members can leave a group');
  await membership.update({ status: 'LEFT', respondedAt: new Date() });
  return ResponseHandler.success(res, membership, 'You have left the group');
});

const borrow = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id); const { group, membership } = await visibleGroup(req.params.groupId, member?.id);
  if (group.creatorMemberId !== member.id || membership.status !== 'ACCEPTED') throw new ForbiddenError('Only the group creator can submit a group borrowing request');
  if (!(await financialEligibility(member.id)).eligible) throw new ForbiddenError('Complete minimum share capital and clear personal outstanding loans before group borrowing');
  const amount = Number(req.body.amount); const months = Number(req.body.paymentPeriodMonths); const rate = Number(req.body.interestRate ?? 1);
  const totalDue = Math.round((amount + amount * rate / 100 * months) * 100) / 100;
  const loan = await db.sequelize.transaction(async (transaction) => {
    const created = await db.GroupLoan.create({ groupId: group.id, requestedByMemberId: member.id, amount, interestRate: rate, paymentPeriodMonths: months, totalDue, balance: totalDue }, { transaction });
    await db.GroupTransaction.create({ groupId: group.id, loanId: created.id, memberId: member.id, type: 'LOAN_DISBURSEMENT', amount, reference: `GRP-DIS-${Date.now()}-${crypto.randomBytes(2).toString('hex')}` }, { transaction });
    return created;
  });
  return ResponseHandler.created(res, loan, 'Group loan recorded successfully');
});

const repay = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id); const { membership } = await visibleGroup(req.params.groupId, member?.id);
  if (membership.status !== 'ACCEPTED') throw new ForbiddenError('Accept the group invitation before making repayments');
  const amount = Number(req.body.amount);
  const result = await db.sequelize.transaction(async (transaction) => {
    const loan = await db.GroupLoan.findOne({ where: { id: req.params.loanId, groupId: req.params.groupId, status: 'ACTIVE' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) throw new NotFoundError('Active group loan not found');
    if (amount > Number(loan.balance)) throw new ValidationError('Repayment cannot exceed the outstanding balance');
    const balance = Math.round((Number(loan.balance) - amount) * 100) / 100;
    await loan.update({ balance, status: balance <= 0 ? 'REPAID' : 'ACTIVE' }, { transaction });
    const payment = await db.GroupTransaction.create({ groupId: loan.groupId, loanId: loan.id, memberId: member.id, type: 'LOAN_REPAYMENT', amount, reference: `GRP-REP-${Date.now()}-${crypto.randomBytes(2).toString('hex')}` }, { transaction });
    return { loan, payment };
  });
  return ResponseHandler.success(res, result, 'Group loan repayment recorded');
});

module.exports = { listGroups, createGroup, searchEligibleMembers, inviteMember, respondInvitation, removeMember, leaveGroup, borrow, repay };
