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
  const member = await db.Member.findByPk(memberId, { attributes: ['userId'] });
  if (member?.userId) await db.User.update({ shareCapitalStatus: shareCapital >= minimumShareCapital ? 'COMPLETED' : 'INCOMPLETE' }, { where: { id: member.userId } });
  return { eligible: shareCapital >= minimumShareCapital && outstandingLoans <= 0, shareCapital, minimumShareCapital, outstandingLoans };
}

const memberInclude = { model: db.Member, as: 'member', attributes: ['id', 'memberNumber', 'userId'], include: [{ model: db.User, attributes: ['name', 'email', 'phone'] }] };
const groupInclude = [
  { model: db.Member, as: 'creator', attributes: ['id', 'memberNumber'], include: [{ model: db.User, attributes: ['name'] }] },
  { model: db.GroupMembership, as: 'memberships', include: [memberInclude] },
  { model: db.GroupLoan, as: 'loans' }, { model: db.GroupTransaction, as: 'transactions' },
  { model: db.GroupLoanProposal, as: 'proposals', include: [{ model: db.GroupLoanAllocation, as: 'allocations', include: [memberInclude] }] },
];

const reducingBalanceInterest = (principal, monthlyRate, months) => Math.round((principal * (monthlyRate / 100) * months * (months + 1) / (2 * months)) * 100) / 100;
const notify = (userId, eventKey, title, body, sourceId, metadata = {}) => db.Notification.create({ userId, eventKey, title, body, category: 'group', severity: title.includes('Rejected') ? 'warning' : 'info', actionUrl: '/dashboard/user/groups', sourceType: 'GroupLoanProposal', sourceId, metadata });

const serializeGroup = (group, viewerMemberId) => {
  const row = group.toJSON();
  const viewerMembership = row.memberships?.find((item) => item.memberId === viewerMemberId);
  const uiMembershipStatus = (status) => status === 'ACTIVE' ? 'ACCEPTED' : status === 'INVITED' ? 'PENDING' : status;
  const repaymentProgress = (row.proposals || []).filter((proposal) => ['DISBURSED', 'APPROVED'].includes(proposal.status)).flatMap((proposal) => {
    const loan = (row.loans || []).find((item) => item.proposalId === proposal.id);
    return (proposal.allocations || []).map((allocation) => {
      const amountPaid = (row.transactions || []).filter((item) => item.loanId === loan?.id && item.memberId === allocation.memberId && item.type === 'LOAN_REPAYMENT' && item.status === 'SUCCESS').reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const totalPayable = Number(allocation.principalAmount) + Number(allocation.interestAmount);
      const startedAt = new Date(proposal.disbursedAt || proposal.approvedAt || proposal.updatedAt);
      const nextDueDate = new Date(startedAt);
      nextDueDate.setMonth(nextDueDate.getMonth() + Math.min(Math.floor(amountPaid / Math.max(totalPayable / proposal.durationMonths, 0.01)) + 1, proposal.durationMonths));
      return { proposalId: proposal.id, loanId: loan?.id || null, memberId: allocation.memberId, memberName: allocation.member?.User?.name || allocation.member?.memberNumber, principalAmount: Number(allocation.principalAmount), interestAmount: Number(allocation.interestAmount), totalPayable, amountPaid, outstandingBalance: Math.max(totalPayable - amountPaid, 0), nextDueDate: amountPaid >= totalPayable ? null : nextDueDate, repaymentStatus: amountPaid >= totalPayable ? 'PAID' : allocation.repaymentStatus };
    });
  });
  return { ...row, isCreator: row.creatorMemberId === viewerMemberId, viewerMembershipId: viewerMembership?.id || null, viewerStatus: uiMembershipStatus(viewerMembership?.status) || null,
    repaymentProgress,
    members: (row.memberships || []).map((item) => ({ id: item.id, memberId: item.memberId, memberNumber: item.member?.memberNumber,
      name: item.member?.User?.name || item.member?.memberNumber, email: item.member?.User?.email, phone: item.member?.User?.phone,
      role: item.role, status: uiMembershipStatus(item.status), membershipStatus: item.status, joinedAt: item.respondedAt || item.createdAt })) };
};

async function visibleGroup(groupId, memberId) {
  const membership = await db.GroupMembership.findOne({ where: { groupId, memberId, status: { [Op.in]: ['INVITED', 'ACTIVE'] } } });
  if (!membership) throw new ForbiddenError('You do not have access to this group');
  const group = await db.BorrowingGroup.findByPk(groupId, { include: groupInclude });
  if (!group) throw new NotFoundError('Group not found');
  return { group, membership };
}

const listGroups = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id);
  if (!member) return ResponseHandler.success(res, { eligibility: null, groups: [] });
  const memberships = await db.GroupMembership.findAll({ where: { memberId: member.id, status: { [Op.in]: ['INVITED', 'ACTIVE'] } }, attributes: ['groupId'] });
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
    await db.GroupMembership.create({ groupId: created.id, memberId: member.id, role: 'CREATOR', status: 'ACTIVE', invitedByMemberId: member.id, respondedAt: new Date() }, { transaction });
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
  const rows = await Promise.all(members.map(async (member) => { const eligibility = await financialEligibility(member.id); return { id: member.id, memberNumber: member.memberNumber, name: member.User?.name || member.memberNumber, email: member.User?.email, ...eligibility, shareCapitalStatus: eligibility.shareCapital >= eligibility.minimumShareCapital ? 'COMPLETED' : 'INCOMPLETE' }; }));
  return ResponseHandler.success(res, rows, 'Members retrieved');
});

const createProposal = asyncHandler(async (req, res) => {
  const creator = await memberForUser(req.user.id); const { group, membership } = await visibleGroup(req.params.groupId, creator?.id);
  if (group.creatorMemberId !== creator?.id || membership.status !== 'ACTIVE') throw new ForbiddenError('Only the group creator can create a proposal');
  const totalPercentage = req.body.allocations.reduce((sum, item) => sum + Number(item.allocatedPercentage), 0);
  if (Math.abs(totalPercentage - 100) > 0.0001) throw new ValidationError('Allocated percentages must equal exactly 100%');
  if (new Set(req.body.allocations.map((item) => item.memberId)).size !== req.body.allocations.length) throw new ValidationError('Each member can only be allocated once');
  const active = await db.GroupMembership.findAll({ where: { groupId: group.id, memberId: { [Op.in]: req.body.allocations.map((item) => item.memberId) }, status: 'ACTIVE' }, include: [memberInclude] });
  if (active.length !== req.body.allocations.length) throw new ValidationError('All allocated members must be active group members');
  const proposal = await db.sequelize.transaction(async (transaction) => {
    const created = await db.GroupLoanProposal.create({ groupId: group.id, createdBy: creator.id, totalAmount: req.body.totalAmount, durationMonths: req.body.durationMonths, interestRate: req.body.interestRate, status: 'PENDING_MEMBER_APPROVAL' }, { transaction });
    await db.GroupLoanAllocation.bulkCreate(req.body.allocations.map((item) => { const principalAmount = Math.round(req.body.totalAmount * Number(item.allocatedPercentage)) / 100; return { proposalId: created.id, memberId: item.memberId, allocatedPercentage: item.allocatedPercentage, principalAmount, interestAmount: reducingBalanceInterest(principalAmount, req.body.interestRate, req.body.durationMonths) }; }), { transaction });
    return created;
  });
  await Promise.all(active.map((row) => notify(row.member.userId, `group-proposal:${proposal.id}:${row.memberId}`, 'Group loan proposal', `${group.name} allocated part of a KES ${Number(req.body.totalAmount).toLocaleString()} loan to you. Review and vote.`, proposal.id, { groupId: group.id, actionRequired: true })));
  return ResponseHandler.created(res, proposal, 'Proposal sent for member approval');
});

const voteProposal = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');
  const requestedAcceptance = req.body.accept ? 'ACCEPTED' : 'REJECTED';
  const result = await db.sequelize.transaction(async (transaction) => {
    const proposal = await db.GroupLoanProposal.findOne({ where: { id: req.params.proposalId, groupId: req.params.groupId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!proposal) throw new NotFoundError('Loan proposal not found');
    const allocation = await db.GroupLoanAllocation.findOne({ where: { proposalId: proposal.id, memberId: member.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (!allocation) throw new ForbiddenError('You are not allocated to this proposal');
    if (allocation.memberAcceptance !== 'PENDING') {
      if (allocation.memberAcceptance !== requestedAcceptance) throw new ValidationError(`You already ${allocation.memberAcceptance.toLowerCase()} this proposal`);
      return { proposal, allocation, status: proposal.status, replayed: true };
    }
    if (proposal.status !== 'PENDING_MEMBER_APPROVAL') throw new ValidationError(`This proposal is already ${proposal.status.toLowerCase().replaceAll('_', ' ')}`);
    await allocation.update({ memberAcceptance: requestedAcceptance, respondedAt: new Date() }, { transaction });
    let status = proposal.status;
    if (!req.body.accept) {
      status = 'REJECTED';
      await proposal.update({ status }, { transaction });
      return { proposal, allocation, status, replayed: false };
    }
    const pendingVotes = await db.GroupLoanAllocation.count({ where: { proposalId: proposal.id, memberAcceptance: 'PENDING' }, transaction });
    if (pendingVotes === 0) {
      status = 'DISBURSED';
      const allocations = await db.GroupLoanAllocation.findAll({ where: { proposalId: proposal.id }, transaction });
      const totalInterest = allocations.reduce((sum, item) => sum + Number(item.interestAmount), 0);
      await proposal.update({ status, approvedAt: new Date(), disbursedAt: new Date() }, { transaction });
      await db.GroupLoan.create({ proposalId: proposal.id, groupId: proposal.groupId, requestedByMemberId: proposal.createdBy, amount: proposal.totalAmount, interestRate: proposal.interestRate, paymentPeriodMonths: proposal.durationMonths, totalDue: Number(proposal.totalAmount) + totalInterest, balance: Number(proposal.totalAmount) + totalInterest }, { transaction });
      await db.GroupLoanAllocation.update({ repaymentStatus: 'ACTIVE' }, { where: { proposalId: proposal.id }, transaction });
      return { proposal, allocation, allocations, status, replayed: false };
    }
    return { proposal, allocation, allocations: [], status, replayed: false };
  });
  const { proposal, allocation, allocations = [], status, replayed } = result;
  if (!replayed && status !== 'PENDING_MEMBER_APPROVAL') setImmediate(async () => {
    const creator = await db.Member.findByPk(proposal.createdBy).catch(() => null);
    const jobs = [];
    if (creator) jobs.push(notify(creator.userId, `group-proposal-decision:${proposal.id}`, status === 'REJECTED' ? 'Group loan rejected' : 'Group loan approved and disbursed', status === 'REJECTED' ? 'A member denied the group loan proposal.' : 'Every allocated member accepted and the group loan was disbursed.', proposal.id, { groupId: proposal.groupId }));
    if (status === 'DISBURSED') for (const item of allocations) jobs.push(db.Member.findByPk(item.memberId).then((allocatedMember) => allocatedMember ? notify(allocatedMember.userId, `group-proposal-disbursed:${proposal.id}:${item.memberId}`, 'Group loan disbursed', `Your principal allocation of KES ${Number(item.principalAmount).toLocaleString()} is confirmed.`, proposal.id, { groupId: proposal.groupId }) : null));
    await Promise.allSettled(jobs);
  });
  return ResponseHandler.success(res, { proposalId: proposal.id, memberAcceptance: allocation.memberAcceptance, status, replayed }, replayed ? `Proposal already ${requestedAcceptance.toLowerCase()}` : `Proposal ${req.body.accept ? 'accepted' : 'rejected'}`);
});

const disburseProposal = asyncHandler(async (req, res) => {
  const creator = await memberForUser(req.user.id);
  const proposal = await db.GroupLoanProposal.findOne({ where: { id: req.params.proposalId, groupId: req.params.groupId, createdBy: creator?.id, status: 'APPROVED' }, include: [{ model: db.GroupLoanAllocation, as: 'allocations', include: [memberInclude] }] });
  if (!proposal) throw new NotFoundError('Approved proposal not found');
  await db.sequelize.transaction(async (transaction) => {
    const totalInterest = proposal.allocations.reduce((sum, item) => sum + Number(item.interestAmount), 0);
    await db.GroupLoan.create({ proposalId: proposal.id, groupId: proposal.groupId, requestedByMemberId: creator.id, amount: proposal.totalAmount, interestRate: proposal.interestRate, paymentPeriodMonths: proposal.durationMonths, totalDue: Number(proposal.totalAmount) + totalInterest, balance: Number(proposal.totalAmount) + totalInterest }, { transaction });
    await proposal.update({ status: 'DISBURSED', disbursedAt: new Date() }, { transaction });
    await db.GroupLoanAllocation.update({ repaymentStatus: 'ACTIVE' }, { where: { proposalId: proposal.id }, transaction });
  });
  await Promise.all(proposal.allocations.map((item) => notify(item.member.userId, `group-proposal-disbursed:${proposal.id}:${item.memberId}`, 'Group loan disbursed', `Your principal allocation of KES ${Number(item.principalAmount).toLocaleString()} is confirmed.`, proposal.id, { groupId: proposal.groupId })));
  return ResponseHandler.success(res, proposal, 'Group loan disbursed');
});

const inviteMember = asyncHandler(async (req, res) => {
  const creator = await memberForUser(req.user.id); const group = await db.BorrowingGroup.findByPk(req.params.groupId);
  if (!group) throw new NotFoundError('Group not found');
  if (group.creatorMemberId !== creator?.id) throw new ForbiddenError('Only the group creator can add members');
  const invited = await db.Member.findOne({ where: { memberNumber: req.body.memberNumber.trim().toUpperCase(), status: 'ACTIVE' }, include: [db.User] });
  if (!invited) throw new NotFoundError('Member not found');
  if (!(await financialEligibility(invited.id)).eligible) throw new ValidationError('This member is not currently eligible for group borrowing');
  let membership = await db.GroupMembership.findOne({ where: { groupId: group.id, memberId: invited.id } });
  if (membership && ['ACTIVE', 'INVITED'].includes(membership.status)) throw new ValidationError('User already in group');
  if (membership) await membership.update({ status: 'INVITED', role: 'MEMBER', invitedByMemberId: creator.id, respondedAt: null });
  else membership = await db.GroupMembership.create({ groupId: group.id, memberId: invited.id, invitedByMemberId: creator.id });
  await db.Notification.create({ userId: invited.userId, eventKey: `group-invite:${membership.id}:${Date.now()}`, title: 'Group invitation', body: `${req.user.name || creator.memberNumber} invited you to join ${group.name}.`, category: 'group', severity: 'info', actionUrl: '/dashboard/user/groups', sourceType: 'GroupMembership', sourceId: membership.id, metadata: { groupId: group.id, membershipId: membership.id, actionRequired: true } });
  return ResponseHandler.created(res, membership, 'Invitation sent successfully');
});

const respondInvitation = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id);
  const membership = await db.GroupMembership.findOne({ where: { id: req.params.membershipId, groupId: req.params.groupId, memberId: member?.id, status: 'INVITED' } });
  if (!membership) throw new NotFoundError('Pending invitation not found');
  await membership.update({ status: req.body.accept ? 'ACTIVE' : 'REJECTED', respondedAt: new Date() });
  return ResponseHandler.success(res, membership, req.body.accept ? 'Invitation accepted' : 'Invitation rejected');
});

const removeMember = asyncHandler(async (req, res) => {
  const creator = await memberForUser(req.user.id); const group = await db.BorrowingGroup.findByPk(req.params.groupId);
  if (!group) throw new NotFoundError('Group not found');
  if (group.creatorMemberId !== creator?.id) throw new ForbiddenError('Only the group creator can remove members');
  const membership = await db.GroupMembership.findOne({ where: { id: req.params.membershipId, groupId: group.id, role: 'MEMBER', status: { [Op.in]: ['INVITED', 'ACTIVE'] } } });
  if (!membership) throw new NotFoundError('Group member not found');
  await membership.update({ status: 'REMOVED', respondedAt: new Date() });
  return ResponseHandler.success(res, membership, 'Member removed from group');
});

const leaveGroup = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id); const { group, membership } = await visibleGroup(req.params.groupId, member?.id);
  if (group.creatorMemberId === member.id) throw new ValidationError('The group creator cannot leave the group');
  if (membership.status !== 'ACTIVE') throw new ValidationError('Only active members can leave a group');
  await membership.update({ status: 'LEFT', respondedAt: new Date() });
  return ResponseHandler.success(res, membership, 'You have left the group');
});

const borrow = asyncHandler(async (req, res) => {
  const member = await memberForUser(req.user.id); const { group, membership } = await visibleGroup(req.params.groupId, member?.id);
  if (group.creatorMemberId !== member.id || membership.status !== 'ACTIVE') throw new ForbiddenError('Only the group creator can submit a group borrowing request');
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
  if (membership.status !== 'ACTIVE') throw new ForbiddenError('Accept the group invitation before making repayments');
  const amount = Number(req.body.amount);
  const result = await db.sequelize.transaction(async (transaction) => {
    const loan = await db.GroupLoan.findOne({ where: { id: req.params.loanId, groupId: req.params.groupId, status: 'ACTIVE' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!loan) throw new NotFoundError('Active group loan not found');
    if (amount > Number(loan.balance)) throw new ValidationError('Repayment cannot exceed the outstanding balance');
    const balance = Math.round((Number(loan.balance) - amount) * 100) / 100;
    await loan.update({ balance, status: balance <= 0 ? 'REPAID' : 'ACTIVE' }, { transaction });
    const payment = await db.GroupTransaction.create({ groupId: loan.groupId, loanId: loan.id, memberId: member.id, type: 'LOAN_REPAYMENT', amount, reference: `GRP-REP-${Date.now()}-${crypto.randomBytes(2).toString('hex')}` }, { transaction });
    if (loan.proposalId) {
      const allocation = await db.GroupLoanAllocation.findOne({ where: { proposalId: loan.proposalId, memberId: member.id }, transaction });
      if (!allocation) throw new ForbiddenError('You do not have a repayment allocation for this loan');
      const paid = await db.GroupTransaction.sum('amount', { where: { loanId: loan.id, memberId: member.id, type: 'LOAN_REPAYMENT', status: 'SUCCESS' }, transaction });
      const memberDue = Number(allocation.principalAmount) + Number(allocation.interestAmount);
      if (Number(paid || 0) > memberDue + 0.005) throw new ValidationError('Repayment exceeds your allocated outstanding balance');
      await allocation.update({ repaymentStatus: Number(paid || 0) >= memberDue - 0.005 ? 'PAID' : 'ACTIVE' }, { transaction });
    }
    return { loan, payment };
  });
  const creator = await db.BorrowingGroup.findByPk(req.params.groupId, { include: [{ model: db.Member, as: 'creator' }] });
  if (creator?.creator?.userId) await notify(creator.creator.userId, `group-payment:${result.payment.id}`, 'Payment received', `${member.memberNumber} paid KES ${amount.toLocaleString()} toward the group loan.`, result.loan.proposalId || result.loan.id, { groupId: req.params.groupId, loanId: result.loan.id });
  return ResponseHandler.success(res, result, 'Group loan repayment recorded');
});

module.exports = { listGroups, createGroup, searchEligibleMembers, inviteMember, respondInvitation, removeMember, leaveGroup, borrow, repay, createProposal, voteProposal, disburseProposal };
