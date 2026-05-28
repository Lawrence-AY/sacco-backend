const db = require('../../../models');

const IMPORTANT_TRANSACTION_STATUSES = new Set(['SUCCESS', 'FAILED', 'PENDING']);
const IMPORTANT_LOAN_STATUSES = new Set(['PENDING', 'APPROVED', 'ACTIVE', 'REJECTED']);

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
  readAt: notification.readAt,
  isRead: Boolean(notification.readAt),
  time: notification.createdAt,
  createdAt: notification.createdAt,
  metadata: notification.metadata || {},
});

const upsertNotification = async (payload) => {
  const [notification, created] = await db.Notification.findOrCreate({
    where: { eventKey: payload.eventKey },
    defaults: payload,
  });

  if (!created) {
    await notification.update({
      title: payload.title,
      body: payload.body,
      category: payload.category,
      severity: payload.severity,
      actionUrl: payload.actionUrl,
      metadata: payload.metadata || {},
    });
  }

  return notification;
};

const syncDashboardEvents = async (user) => {
  const member = await db.Member.findOne({ where: { userId: user.id } });
  const tasks = [];

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
        tasks.push(upsertNotification({
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
        }));
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
        tasks.push(upsertNotification({
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
        }));
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
      tasks.push(upsertNotification({
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
      }));
    });

  await Promise.all(tasks);
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

module.exports = {
  listForUser,
  markRead,
  markAllRead,
};
