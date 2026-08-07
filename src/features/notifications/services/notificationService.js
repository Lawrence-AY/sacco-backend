const db = require('../../../models');
const { Op } = require('sequelize');
const { enqueueEmail, QUEUES } = require('../../../services/email/emailQueue');

const IMPORTANT_TRANSACTION_STATUSES = new Set(['SUCCESS', 'FAILED', 'PENDING']);
const IMPORTANT_LOAN_STATUSES = new Set(['PENDING', 'PENDING_GUARANTORS', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'REJECTED']);

const severityForStatus = (status) => {
  const normalized = String(status || '').toUpperCase();
  if (['SUCCESS', 'APPROVED', 'ACTIVE', 'COMPLETED', 'PAID'].includes(normalized)) return 'success';
  if (['FAILED', 'REJECTED', 'BLOCKED'].includes(normalized)) return 'critical';
  if (['PENDING', 'PROCESSING'].includes(normalized)) return 'warning';
  return 'info';
};

const serialize = (notification) => ({
  id: notification.id,
  title: notification.title,
  body: notification.body,
  category: notification.category,
  severity: notification.severity,
  tone: notification.severity === 'critical' ? 'warning' : notification.severity,
  actionUrl: notification.actionUrl,
  sourceType: notification.sourceType,
  sourceId: notification.sourceId,
  readAt: notification.readAt,
  isRead: Boolean(notification.readAt),
  time: notification.createdAt,
  createdAt: notification.createdAt,
  metadata: notification.metadata || {},
});

const upsertNotification = async (payload, options = {}) => {
  const [notification, created] = await db.Notification.findOrCreate({
    where: { eventKey: payload.eventKey },
    defaults: payload,
    transaction: options.transaction,
  });

  if (!created) {
    await notification.update({
      title: payload.title,
      body: payload.body,
      category: payload.category,
      severity: payload.severity,
      actionUrl: payload.actionUrl,
      metadata: payload.metadata || {},
    }, { transaction: options.transaction });
  }

  return notification;
};

const getLoanWithApplicant = async (loanId, options = {}) => {
  return db.Loan.findByPk(loanId, {
    include: [{
      model: db.Member,
      include: [{
        model: db.User,
        attributes: ['id', 'name', 'firstName', 'lastName', 'email', 'phone'],
      }],
    }],
    transaction: options.transaction,
  });
};

const formatApplicantName = (user, member) => {
  return user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || member?.memberNumber || 'Member';
};

const formatDateTime = (value) => new Date(value || Date.now()).toLocaleString('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const queueLoanEmail = async ({ to, subject, title, lines }) => {
  if (!to) return null;
  return enqueueEmail(QUEUES.NOTIFICATIONS, 'NOTIFICATION', {
    to,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5">
        <h2>${title}</h2>
        ${lines.map((line) => `<p>${line}</p>`).join('')}
        <p style="color:#64748b;font-size:12px">Generated at ${formatDateTime(new Date())}.</p>
      </div>
    `,
  }).catch(() => null);
};

const createFinanceLoanRequestNotifications = async (loanId) => {
  const loan = await getLoanWithApplicant(loanId);
  if (!loan) return [];

  const member = loan.Member;
  const applicant = formatApplicantName(member?.User, member);
  const financeUsers = await db.User.findAll({
    where: { role: { [Op.in]: ['FINANCE', 'ADMIN', 'SUPERADMIN'] } },
    attributes: ['id'],
  });

  const notifications = await Promise.all(financeUsers.map((recipient) => upsertNotification({
    userId: recipient.id,
    eventKey: `finance:loan-request:${loan.id}:${recipient.id}`,
    title: 'New loan request',
    body: `${applicant} requested KES ${Number(loan.amount || 0).toLocaleString()} for ${loan.type || 'a loan'}.`,
    category: 'loan',
    severity: 'warning',
    actionUrl: `/dashboard/finance/notifications?loanId=${loan.id}`,
    sourceType: 'Loan',
    sourceId: loan.id,
    metadata: {
      subtype: 'application',
      status: loan.status,
      type: loan.type,
      loanId: loan.id,
      memberId: loan.memberId,
      memberNumber: member?.memberNumber || null,
      applicantName: applicant,
      memberName: applicant,
      amount: loan.amount,
      reason: loan.reason || null,
      duration: loan.duration,
      interestRate: loan.interestRate,
      requestedAt: loan.createdAt,
    },
  })));

  return notifications.map(serialize);
};

const createMemberLoanDecisionNotification = async (loanId, decision, payload = {}) => {
  const transaction = payload.transaction || null;
  const loan = await getLoanWithApplicant(loanId, { transaction });
  if (!loan?.Member?.userId) return null;

  const status = String(decision || loan.status || '').toUpperCase();
  const approved = status === 'APPROVED';
  const amount = Number(payload.approvedAmount ?? loan.amount ?? 0);
  const interestRate = Number(payload.interestRate ?? loan.interestRate ?? 0);
  const duration = Number(payload.duration ?? loan.duration ?? 0);
  const rejectionReason = payload.reason || loan.rejectionReason || 'Your application did not meet the approval criteria.';
  const decidedAt = loan.decidedAt || loan.updatedAt || new Date();
  const breakdown = approved
    ? `Approved amount: KES ${amount.toLocaleString()}. Interest rate: ${interestRate}% monthly. Repayment term: ${duration} month${duration === 1 ? '' : 's'}.`
    : `Reason for rejection: ${rejectionReason}`;

  const notification = await upsertNotification({
    userId: loan.Member.userId,
    eventKey: `loan:${loan.id}:${status}`,
    title: approved ? 'Loan approved' : 'Loan rejected',
    body: `${loan.type || 'Loan'} request for KES ${Number(loan.amount || 0).toLocaleString()} was ${status.toLowerCase()}. ${breakdown}`,
    category: 'loan',
    severity: approved ? 'success' : 'critical',
    actionUrl: '/dashboard/user/loans',
    sourceType: 'Loan',
    sourceId: loan.id,
    metadata: {
      subtype: 'decision',
      status,
      loanId: loan.id,
      approvedAmount: approved ? amount : null,
      interestRate: approved ? interestRate : null,
      repaymentTerms: approved ? `${duration} month${duration === 1 ? '' : 's'}` : null,
      rejectionReason: approved ? null : rejectionReason,
      decidedAt,
    },
  }, { transaction });

  if (!payload.skipEmail) {
    await queueLoanEmail({
      to: loan.Member?.User?.email,
      subject: approved ? 'Your AYEDOS SACCO loan has been approved' : 'Your AYEDOS SACCO loan decision',
      title: approved ? 'Loan approved' : 'Loan rejected',
      lines: approved ? [
        `Your ${loan.type || 'loan'} request for KES ${Number(loan.amount || 0).toLocaleString()} was approved on ${formatDateTime(decidedAt)}.`,
        `Approved amount: KES ${amount.toLocaleString()}. Repayment period: ${duration} month${duration === 1 ? '' : 's'}.`,
      ] : [
        `Your ${loan.type || 'loan'} request for KES ${Number(loan.amount || 0).toLocaleString()} was rejected on ${formatDateTime(decidedAt)}.`,
        `Decision reason: ${rejectionReason}`,
      ],
    });
  }

  return serialize(notification);
};

const getPublicBaseUrl = () => (
  process.env.FRONTEND_URL
  || process.env.CLIENT_URL
  || process.env.CORS_ORIGIN
  || 'http://localhost:5173'
).split(',')[0].replace(/\/+$/, '');

const createGuarantorRequestNotifications = async (loanId) => {
  const loan = await db.Loan.findByPk(loanId, {
    include: [
      { model: db.Member, include: [{ model: db.User, attributes: ['id', 'name', 'firstName', 'lastName', 'email', 'phone'] }] },
      { model: db.Guarantor, include: [{ model: db.Member, include: [{ model: db.User, attributes: ['id', 'name', 'firstName', 'lastName', 'email', 'phone'] }] }] },
    ],
  });
  if (!loan) return [];

  const applicant = formatApplicantName(loan.Member?.User, loan.Member);
  const baseUrl = getPublicBaseUrl();
  const pending = (loan.Guarantors || []).filter((guarantor) => guarantor.status === 'PENDING');

  const notifications = await Promise.all(pending.map(async (guarantor) => {
    const recipient = guarantor.Member?.User;
    if (!recipient?.id) return null;
    const actionUrl = `/guarantor-request/${guarantor.requestToken}`;
    const fullUrl = `${baseUrl}${actionUrl}`;
    await queueLoanEmail({
      to: recipient.email,
      subject: 'AYEDOS SACCO guarantor request',
      title: 'Loan guarantor request',
      lines: [
        `${applicant} requested you as a guarantor for a ${loan.type || 'loan'} of KES ${Number(loan.amount || 0).toLocaleString()}.`,
        `Review and respond within 72 hours: <a href="${fullUrl}">${fullUrl}</a>`,
      ],
    });
    return upsertNotification({
      userId: recipient.id,
      eventKey: `guarantor-request:${guarantor.id}:${recipient.id}`,
      title: 'Guarantor request',
      body: `${applicant} requested your guarantee for KES ${Number(loan.amount || 0).toLocaleString()}. The link expires in 72 hours.`,
      category: 'loan',
      severity: 'warning',
      actionUrl,
      sourceType: 'Guarantor',
      sourceId: guarantor.id,
      metadata: {
        subtype: 'guarantor_request',
        loanId: loan.id,
        guarantorId: guarantor.id,
        applicantName: applicant,
        amount: loan.amount,
        expiresAt: guarantor.tokenExpiresAt,
      },
    });
  }));

  return notifications.filter(Boolean).map(serialize);
};

const createApplicantGuarantorDecisionNotification = async (loanId, guarantorId) => {
  const loan = await getLoanWithApplicant(loanId);
  const guarantor = await db.Guarantor.findByPk(guarantorId, {
    include: [{ model: db.Member, include: [{ model: db.User, attributes: ['name', 'firstName', 'lastName'] }] }],
  });
  if (!loan?.Member?.userId || !guarantor) return null;

  const guarantorName = formatApplicantName(guarantor.Member?.User, guarantor.Member);
  const status = String(guarantor.status || 'PENDING').toUpperCase();
  const notification = await upsertNotification({
    userId: loan.Member.userId,
    eventKey: `loan:${loan.id}:guarantor:${guarantor.id}:${status}`,
    title: 'Guarantor response received',
    body: `${guarantorName} ${status.toLowerCase()} your guarantor request for ${loan.type || 'loan'}.`,
    category: 'loan',
    severity: status === 'ACCEPTED' ? 'success' : 'critical',
    actionUrl: '/dashboard/user/loans',
    sourceType: 'Loan',
    sourceId: loan.id,
    metadata: {
      subtype: 'guarantor_decision',
      loanId: loan.id,
      guarantorId: guarantor.id,
      guarantorName,
      status,
      allAccepted: String(loan.status || '').toUpperCase() === 'UNDER_REVIEW',
    },
  });

  return serialize(notification);
};

const createFinanceEmergencyAutoApprovalNotifications = async (loanId, payload = {}) => {
  const loan = await getLoanWithApplicant(loanId);
  if (!loan) return [];

  const member = loan.Member;
  const applicant = formatApplicantName(member?.User, member);
  const financeUsers = await db.User.findAll({
    where: { role: { [Op.in]: ['FINANCE', 'ADMIN', 'SUPERADMIN'] } },
    attributes: ['id'],
  });

  const notifications = await Promise.all(financeUsers.map((recipient) => upsertNotification({
    userId: recipient.id,
    eventKey: `finance:emergency-auto-approved:${loan.id}:${recipient.id}`,
    title: 'Emergency loan auto-approved',
    body: `${applicant}'s emergency loan for KES ${Number(loan.amount || 0).toLocaleString()} passed automated checks and is queued for wallet disbursement within 1 hour.`,
    category: 'loan',
    severity: 'success',
    actionUrl: `/dashboard/finance/notifications?loanId=${loan.id}`,
    sourceType: 'Loan',
    sourceId: loan.id,
    metadata: {
      subtype: 'application',
      automated: true,
      status: 'APPROVED',
      type: loan.type,
      loanId: loan.id,
      memberId: loan.memberId,
      memberNumber: member?.memberNumber || null,
      applicantName: applicant,
      memberName: applicant,
      amount: loan.amount,
      reason: loan.reason || null,
      duration: loan.duration,
      interestRate: loan.interestRate,
      requestedAt: loan.createdAt,
      decidedAt: loan.decidedAt || loan.updatedAt,
      disbursementDeadline: payload.disbursementDeadline,
      riskChecks: payload.riskChecks || [],
    },
  })));

  await queueLoanEmail({
    to: member?.User?.email,
    subject: 'Your AYEDOS SACCO emergency loan is approved',
    title: 'Emergency loan auto-approved',
    lines: [
      `Your emergency loan request for KES ${Number(loan.amount || 0).toLocaleString()} was approved on ${formatDateTime(loan.decidedAt || loan.updatedAt)}.`,
      'The funds have been queued for your withdrawable wallet and should arrive within 1 hour.',
    ],
  });

  return notifications.map(serialize);
};

const isFinanceUser = (user) => ['FINANCE', 'ADMIN', 'SUPERADMIN'].includes(String(user?.role || '').toUpperCase());

const syncDashboardEvents = async (user) => {
  const member = await db.Member.findOne({ where: { userId: user.id } });
  const tasks = [];

  if (isFinanceUser(user)) {
    const pendingLoans = await db.Loan.findAll({
      where: { status: 'PENDING' },
      include: [{
        model: db.Member,
        include: [{
          model: db.User,
          attributes: ['id', 'name', 'firstName', 'lastName', 'email', 'phone'],
        }],
      }],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    pendingLoans.forEach((loan) => {
      const applicant = formatApplicantName(loan.Member?.User, loan.Member);
      tasks.push({
        userId: user.id,
        eventKey: `finance:loan-request:${loan.id}:${user.id}`,
        title: 'New loan request',
        body: `${applicant} requested KES ${Number(loan.amount || 0).toLocaleString()} for ${loan.type || 'a loan'}.`,
        category: 'loan',
        severity: 'warning',
        actionUrl: `/dashboard/finance/notifications?loanId=${loan.id}`,
        sourceType: 'Loan',
        sourceId: loan.id,
        metadata: {
          subtype: 'application',
          status: loan.status,
          type: loan.type,
          loanId: loan.id,
          memberId: loan.memberId,
          memberNumber: loan.Member?.memberNumber || null,
          applicantName: applicant,
          memberName: applicant,
          amount: loan.amount,
          reason: loan.reason || null,
          duration: loan.duration,
          interestRate: loan.interestRate,
          requestedAt: loan.createdAt,
          submittedBy: applicant,
        },
      });
    });
  }

  if (member) {
    const transactions = await db.Transaction.findAll({
      where: { memberId: member.id },
      order: [['createdAt', 'DESC']],
      limit: 20,
    });

    transactions
      .filter((transaction) => IMPORTANT_TRANSACTION_STATUSES.has(String(transaction.status || '').toUpperCase()))
      .forEach((transaction) => {
        const status = String(transaction.status || 'PENDING').toUpperCase();
        const label = transaction.paymentCategory || transaction.description || transaction.type || 'Transaction';
        tasks.push({
          userId: user.id,
          eventKey: `transaction:${transaction.id}:${status}`,
          title: status === 'FAILED' ? 'Payment needs attention' : status === 'SUCCESS' ? 'Payment confirmed' : 'Payment is pending',
          body: `${label} of KES ${Number(transaction.amount || 0).toLocaleString()} is ${status.toLowerCase()}.`,
          category: 'transaction',
          severity: severityForStatus(status),
          actionUrl: '/dashboard/user/transactions',
          sourceType: 'Transaction',
          sourceId: transaction.id,
          metadata: { status, reference: transaction.reference },
        });
      });

    const loans = await db.Loan.findAll({
      where: { memberId: member.id },
      order: [['updatedAt', 'DESC']],
      limit: 20,
    });

    loans
      .filter((loan) => IMPORTANT_LOAN_STATUSES.has(String(loan.status || '').toUpperCase()))
      .forEach((loan) => {
        const status = String(loan.status || 'PENDING').toUpperCase();
        tasks.push({
          userId: user.id,
          eventKey: `loan:${loan.id}:${status}`,
          title: status === 'APPROVED' || status === 'ACTIVE' ? 'Loan update available' : status === 'REJECTED' ? 'Loan application update' : 'Loan application received',
          body: `${loan.type || 'Loan'} request for KES ${Number(loan.amount || 0).toLocaleString()} is ${status.toLowerCase()}.`,
          category: 'loan',
          severity: severityForStatus(status),
          actionUrl: '/dashboard/user/loans',
          sourceType: 'Loan',
          sourceId: loan.id,
          metadata: { status, approvalStage: loan.approvalStage },
        });
      });
  }

  const sessions = await db.LoginSession.findAll({
    where: { userId: user.id },
    order: [['createdAt', 'DESC']],
    limit: 5,
  }).catch(() => []);

  sessions
    .filter((session) => session.isNewDevice || String(session.status || '').toUpperCase() === 'ACTIVE')
    .forEach((session) => {
      tasks.push({
        userId: user.id,
        eventKey: `session:${session.id}:${session.isNewDevice ? 'new' : 'active'}`,
        title: session.isNewDevice ? 'New device sign-in' : 'Active dashboard session',
        body: `${session.deviceName || 'A device'} accessed your dashboard${session.location ? ` from ${session.location}` : ''}.`,
        category: 'security',
        severity: session.isNewDevice ? 'warning' : 'info',
        actionUrl: '/dashboard/user/security',
        sourceType: 'LoginSession',
        sourceId: session.id,
        metadata: { ip: session.ipAddress, status: session.status },
      });
    });

  await Promise.all(tasks.map((payload) => upsertNotification(payload)));
};

const listForUser = async (user, { unreadOnly = false, limit = 30 } = {}) => {
  await syncDashboardEvents(user);
  const notifications = await db.Notification.findAll({
    where: {
      userId: user.id,
      ...(unreadOnly ? { readAt: null } : {}),
    },
    order: [['createdAt', 'DESC']],
    limit: Math.min(Number(limit) || 30, 100),
  });

  return notifications.map(serialize);
};

const markRead = async (user, id) => {
  const notification = await db.Notification.findOne({ where: { id, userId: user.id } });
  if (!notification) return null;
  await notification.update({ readAt: notification.readAt || new Date() });
  return serialize(notification);
};

const markAllRead = async (user) => {
  await db.Notification.update({ readAt: new Date() }, { where: { userId: user.id, readAt: null } });
};

const createManualNotification = async (sender, payload = {}) => {
  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  const audience = String(payload.audience || 'MEMBER').toUpperCase();
  const category = String(payload.category || 'announcement').trim() || 'announcement';
  const severity = String(payload.severity || 'info').trim() || 'info';
  const recipientUserId = payload.recipientUserId || null;

  if (!title || !body) {
    const error = new Error('Title and message are required.');
    error.statusCode = 400;
    throw error;
  }

  let users = [];

  if (audience === 'INDIVIDUAL') {
    if (!recipientUserId) {
      const error = new Error('Please choose a member to notify.');
      error.statusCode = 400;
      throw error;
    }

    const recipient = await db.User.findOne({
      where: { id: recipientUserId, role: 'MEMBER' },
      attributes: ['id'],
    });

    if (!recipient) {
      const error = new Error('Selected member was not found.');
      error.statusCode = 404;
      throw error;
    }

    users = [recipient];
  } else {
    const rolesByAudience = {
      ALL: ['MEMBER', 'FINANCE', 'ADMIN', 'SUPERADMIN'],
      MEMBERS: ['MEMBER'],
      MEMBER: ['MEMBER'],
      FINANCE: ['FINANCE'],
      ADMINS: ['ADMIN', 'SUPERADMIN'],
      ADMIN: ['ADMIN', 'SUPERADMIN'],
    };

    const roles = rolesByAudience[audience] || rolesByAudience.MEMBER;
    users = await db.User.findAll({
      where: { role: { [Op.in]: roles } },
      attributes: ['id'],
    });
  }

  const now = Date.now();
  const notifications = await Promise.all(users.map((recipient, index) => upsertNotification({
    userId: recipient.id,
    eventKey: `manual:${sender.id}:${now}:${index}`,
    title,
    body,
    category,
    severity,
    actionUrl: payload.actionUrl || null,
    sourceType: 'ManualNotification',
    sourceId: null,
    metadata: {
      audience,
      recipientUserId,
      sentBy: sender.id,
    },
  })));

  return {
    sent: notifications.length,
    notifications: notifications.map(serialize),
  };
};

module.exports = {
  listForUser,
  markRead,
  markAllRead,
  createManualNotification,
  createFinanceLoanRequestNotifications,
  createFinanceEmergencyAutoApprovalNotifications,
  createMemberLoanDecisionNotification,
  createGuarantorRequestNotifications,
  createApplicantGuarantorDecisionNotification,
};
