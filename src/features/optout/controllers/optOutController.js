const { Op } = require('sequelize');
const db = require('../../../models');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ForbiddenError, ValidationError } = require('../../../shared/utils/errors');
const { formatEAT } = require('../../../shared/utils/eatDateTime');
const { enqueueEmail, QUEUES } = require('../../../services/email/emailQueue');

const include = [{ model: db.Member, include: [{ model: db.User, attributes: ['id', 'name', 'email', 'phone'] }] }];
const serialize = (request) => {
  const row = request.toJSON(); const member = row.Member; const user = member?.User;
  return { ...row, memberNumber: member?.memberNumber, memberName: user?.name, memberEmail: user?.email,
    requestedAtEAT: formatEAT(row.requestedAt), disbursedAtEAT: formatEAT(row.disbursedAt),
    canDisburse: row.adminApproval && row.financeApproval && row.status === 'APPROVED' };
};

const notifyMember = async (request, payload, options = {}) => {
  const loaded = request.Member ? request : await db.MemberExitRequest.findByPk(request.id, { include, transaction: options.transaction });
  const userId = loaded?.Member?.User?.id;
  if (!userId) return null;
  return db.Notification.create({
    userId,
    category: 'opt_out',
    sourceType: 'MemberExitRequest',
    sourceId: loaded.id,
    actionUrl: '/dashboard/member/notifications',
    metadata: { requestId: loaded.id, status: loaded.status, ...(payload.metadata || {}) },
    ...payload,
  }, { transaction: options.transaction }).catch(() => null);
};

const list = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1); const limit = [10, 25].includes(Number(req.query.limit)) ? Number(req.query.limit) : 10;
  const where = req.query.status && req.query.status !== 'ALL' ? { status: req.query.status } : { status: { [Op.in]: ['PENDING', 'APPROVED', 'REJECTED', 'DISBURSED'] } };
  const result = await db.MemberExitRequest.findAndCountAll({ where, include, order: [['requestedAt', 'DESC']], limit, offset: (page - 1) * limit, distinct: true });
  return ResponseHandler.paginated(res, result.rows.map(serialize), { page, limit, total: result.count, totalPages: Math.ceil(result.count / limit) }, 'Opt-out requests retrieved');
});

const review = asyncHandler(async (req, res) => {
  const role = String(req.user.role || '').toUpperCase();
  if (!['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(role)) throw new ForbiddenError('Approval role required');
  const request = await db.MemberExitRequest.findByPk(req.params.requestId);
  if (!request) throw new NotFoundError('Opt-out request not found');
  if (['REJECTED', 'DISBURSED', 'CANCELLED'].includes(request.status)) throw new ValidationError('This opt-out request can no longer be reviewed');
  const approve = req.body.approve === true; const now = new Date();
  if (!approve) {
    const rejectionReason = req.body.reason || 'Rejected during review';
    await request.update({ status: 'REJECTED', rejectionReason, reviewedAt: now, reviewedById: req.user.id });
    await notifyMember(request, {
      eventKey: `opt-out-rejected:${request.id}`,
      title: 'Opt-out request denied',
      body: `Your opt-out request was denied. Reason: ${rejectionReason}`,
      severity: 'critical',
      metadata: { rejectionReason },
    });
  }
  else {
    const update = role === 'FINANCE' ? { financeApproval: true, financeApprovedAt: now, financeReviewedById: req.user.id } : { adminApproval: true, adminApprovedAt: now, adminReviewedById: req.user.id };
    await request.update(update); await request.reload();
    if (request.adminApproval && request.financeApproval) {
      await request.update({ status: 'APPROVED', reviewedAt: now });
      await notifyMember(request, {
        eventKey: `opt-out-approved:${request.id}`,
        title: 'Opt-out request approved',
        body: 'Your opt-out request has been approved. You should receive your savings shortly via your registered payout method.',
        severity: 'success',
      });
    }
  }
  const loaded = await db.MemberExitRequest.findByPk(request.id, { include });
  return ResponseHandler.success(res, serialize(loaded), approve ? 'Approval recorded' : 'Opt-out request rejected');
});

const disburse = asyncHandler(async (req, res) => {
  if (String(req.user.role).toUpperCase() !== 'FINANCE') throw new ForbiddenError('Only Finance can disburse savings');
  const result = await db.sequelize.transaction(async (transaction) => {
    const request = await db.MemberExitRequest.findByPk(req.params.requestId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!request) throw new NotFoundError('Opt-out request not found');
    if (!(request.adminApproval && request.financeApproval && request.status === 'APPROVED')) throw new ValidationError('Admin and Finance approvals are both required before disbursement');
    const account = await db.SavingsAccount.findOne({ where: { memberId: request.memberId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!account) throw new NotFoundError('Active savings account not found');
    const amount = Number(account.balance || 0); if (amount <= 0) throw new ValidationError('Member has no active savings balance to disburse');
    const ledger = await db.Transaction.create({ memberId: request.memberId, type: 'WITHDRAWAL', amount, method: 'MANUAL', status: 'SUCCESS', reference: `OPT-DIS-${Date.now()}`, description: 'Opt-out savings disbursement', paymentCategory: 'opt_out_savings_disbursement' }, { transaction });
    await account.update({ balance: 0 }, { transaction });
    const member = await db.Member.findByPk(request.memberId, { include: [db.User], transaction, lock: transaction.LOCK.UPDATE });
    await db.Member.update({ status: 'TERMINATED', isVerified: false }, { where: { id: request.memberId }, transaction });
    if (member?.userId) {
      await db.User.update({ isVerified: false, role: 'PENDING' }, { where: { id: member.userId }, transaction });
      await db.LoginSession.update({ status: 'LOGGED_OUT', event: 'Membership exited', logoutAt: new Date(), lastActiveAt: new Date() }, { where: { userId: member.userId, status: 'ACTIVE' }, transaction });
    }
    await request.update({ status: 'DISBURSED', disbursedAmount: amount, disbursedAt: new Date(), disbursedById: req.user.id, disbursementTransactionId: ledger.id, accessRevokedAt: new Date() }, { transaction });
    return { request, ledger };
  });
  const loaded = await db.MemberExitRequest.findByPk(result.request.id, { include });
  await notifyMember(loaded, {
    eventKey: `opt-out-closed:${loaded.id}`,
    title: 'Membership closed',
    body: 'Your membership has been formally closed and your account access has been deactivated.',
    severity: 'info',
  });
  const memberUser = loaded?.Member?.User;
  if (memberUser?.email) {
    await enqueueEmail(QUEUES.NOTIFICATIONS, 'NOTIFICATION', {
      to: memberUser.email,
      subject: 'SACCO membership closed',
      html: `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2>Membership closed</h2><p>Your membership has been formally closed and your account access has been deactivated.</p></div>`,
    }).catch(() => null);
  }
  return ResponseHandler.success(res, { request: serialize(loaded), ledgerTransactionId: result.ledger.id }, 'Savings disbursed successfully');
});

module.exports = { list, review, disburse };
