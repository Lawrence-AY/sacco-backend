const db = require('../../../models');
const { Op } = require('sequelize');
const userService = require('../../users/services/userService');
const applicationService = require('../../applications/services/applicationService');
const notificationService = require('../../notifications/services/notificationService');
const bcrypt = require('bcrypt');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../../shared/utils/errors');
const { UserDTO } = require('../../../shared/utils/dtos');

const detectDelimiter = (line = '') => {
  const candidates = [',', ';', '\t'];
  let quoted = false;
  const counts = Object.fromEntries(candidates.map((delimiter) => [delimiter, 0]));
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && candidates.includes(char)) {
      counts[char] += 1;
    }
  }
  return candidates.sort((a, b) => counts[b] - counts[a])[0] || ',';
};

const parseCsv = (csvText = '') => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let text = String(csvText || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] || '';
  let delimiter = detectDelimiter(firstLine);
  if (/^sep=./i.test(firstLine.trim())) {
    delimiter = firstLine.trim().slice(4, 5) || delimiter;
    text = text.slice(firstLine.length).replace(/^\r?\n/, '');
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header || '').trim());
  return rows.slice(1).map((values, index) => ({
    rowNumber: index + 2,
    raw: Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex] ?? ''])),
  }));
};

const pick = (row, aliases) => {
  const entries = Object.entries(row.raw);
  const normalized = aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const match = entries.find(([key]) => normalized.includes(String(key).toLowerCase().replace(/[^a-z0-9]/g, '')));
  return String(match?.[1] ?? '').trim();
};

const toNumber = (value) => {
  const number = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : 0;
};

const hasStaffId = (value) => Boolean(String(value || '').trim());

const mapMemberImportRow = (row) => {
  const fullName = pick(row, ['name', 'fullName', 'memberName', 'memberNameFull']);
  const email = pick(row, ['email', 'emailAddress', 'username']).toLowerCase();
  const phone = pick(row, ['phone', 'phoneNumber', 'mobile', 'mobileNumber', 'telephone']);
  const nationalId = pick(row, ['nationalId', 'nationalID', 'idNumber', 'nationalIdentificationNumber']);
  const memberNumber = pick(row, ['memberNumber', 'registrationNumber', 'memberNo', 'memberId', 'memberID']);
  const staffId = pick(row, ['staffId', 'staffID', 'payrollNumber', 'employeeId']);
  const status = pick(row, ['status']) || 'ACTIVE';
  const shareCapital = toNumber(pick(row, ['shareCapital', 'share capital', 'shares']));
  const savings = toNumber(pick(row, ['savings', 'savingsBalance']));
  const joinDate = pick(row, ['joinDate', 'joinedDate', 'dateJoined', 'joiningDate']);
  const missing = [];
  if (!fullName) missing.push('name');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) missing.push('email');
  if (!phone) missing.push('phone');
  if (!nationalId) missing.push('nationalId');
  return {
    rowNumber: row.rowNumber,
    ready: missing.length === 0,
    missing,
    data: {
      fullName,
      email,
      phone,
      nationalId,
      memberNumber,
      staffId,
      shareCapital,
      savings,
      joinDate,
      status: status.toUpperCase(),
      company: 'Ayedos',
      isWhitelisted: true,
    },
  };
};

const mapFinancialImportRow = (row) => {
  const sheetName = pick(row, ['sheet', 'worksheet', 'workbookSheet']);
  const memberNumber = pick(row, ['memberNumber', 'registrationNumber', 'memberNo', 'memberId', 'memberID']);
  const email = pick(row, ['email', 'emailAddress']).toLowerCase();
  const staffId = pick(row, ['staffId', 'staffID', 'payrollNumber', 'employeeId']);
  const missing = [];
  if (!memberNumber && !email && !staffId) missing.push('memberNumber/email/staffId');
  return {
    rowNumber: row.rowNumber,
    ready: missing.length === 0,
    missing,
    data: {
      memberNumber,
      sheetName,
      email,
      staffId,
      shareCapital: toNumber(pick(row, ['shareCapital', 'shares'])),
      savings: toNumber(pick(row, ['savings', 'savingsBalance'])),
      loans: toNumber(pick(row, ['loans', 'loanBalance'])),
      loanRepayment: toNumber(pick(row, ['loanRepayment', 'repayments'])),
      interest: toNumber(pick(row, ['interest', 'interestEarned'])),
      employerContribution: toNumber(pick(row, ['employerContribution', 'employerContrib'])),
      totalShares: toNumber(pick(row, ['totalShares', 'sharesHeld', 'dividendShares'])),
      dividendPaid: toNumber(pick(row, ['dividendPaid', 'dividend', 'dividends', 'dividendAmount', 'annualDividend'])),
      financialYear: toNumber(pick(row, ['financialYear', 'year', 'dividendYear'])),
    },
  };
};

const isDividendImportRow = (row) => {
  const data = row?.data || {};
  const sheetName = String(data.sheetName || '').toLowerCase();
  return sheetName.includes('dividend') || Number(data.dividendPaid || 0) > 0 || Number(data.totalShares || 0) > 0;
};

const formatMember = (member) => {
  if (!member) return null;
  const source = typeof member.toJSON === 'function' ? member.toJSON() : member;
  return {
    id: source.id,
    userId: source.userId,
    memberNumber: source.memberNumber,
    type: source.type,
    isVerified: source.isVerified,
    createdAt: source.createdAt,
  };
};

const formatAdminMemberRow = (member) => {
  const source = typeof member?.toJSON === 'function' ? member.toJSON() : member;
  const user = source?.User || source?.user || {};
  return {
    id: user.id || source?.userId || source?.id,
    userId: user.id || source?.userId,
    memberId: source?.id,
    memberNumber: source?.memberNumber || '',
    name: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || '',
    email: user.email || '',
    phone: user.phone || '',
    nationalId: user.nationalId || source?.nationalId || '',
    company: user.employer || '',
    staffId: user.staffId || '',
    status: source?.status || (user.isVerified ? 'ACTIVE' : 'PENDING'),
    isVerified: Boolean(source?.isVerified || user.isVerified),
    createdAt: source?.createdAt || user.createdAt,
    archivedAt: source?.updatedAt || user.updatedAt,
    reason: source?.status && source.status !== 'ACTIVE' ? source.status : 'Inactive or unverified account',
  };
};

const getAllUsers = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsers();
  return ResponseHandler.success(res, users.map(UserDTO.admin), 'Users retrieved successfully', 200);
});

const getArchivedMembers = asyncHandler(async (req, res) => {
  const members = await db.Member.findAll({
    where: {
      [Op.or]: [
        { status: { [Op.ne]: 'ACTIVE' } },
        { isVerified: false },
      ],
    },
    include: [{ model: db.User, attributes: { exclude: ['password', 'otp', 'refreshToken', 'passwordResetToken', 'passwordResetExpires'] } }],
    order: [['updatedAt', 'DESC']],
    limit: 250,
  });
  return ResponseHandler.success(res, members.map(formatAdminMemberRow), 'Archived members retrieved successfully', 200);
});

const getAuditLogs = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const where = {};
  if (req.query.module) where.module = String(req.query.module);
  if (req.query.action) where.action = String(req.query.action);
  const logs = await db.AuditLog.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  return ResponseHandler.success(res, logs, 'Audit logs retrieved successfully', 200);
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.admin(user), 'User retrieved successfully', 200);
});

const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!role) {
    throw new ValidationError('Role is required');
  }

  if (role === 'SUPERADMIN' && req.user.role !== 'SUPERADMIN') {
    throw new ForbiddenError('Only superadmins can grant the superadmin role');
  }

  const updatedUser = await userService.updateUser(req.params.userId, { role });
  if (!updatedUser) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.admin(updatedUser), 'User role updated successfully', 200);
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const { active } = req.body;
  if (active === undefined) {
    throw new ValidationError('Active status is required');
  }

  const updatedUser = await userService.updateUser(req.params.userId, { isVerified: Boolean(active) });
  if (!updatedUser) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.admin(updatedUser), 'User status updated successfully', 200);
});

const getAllApplications = asyncHandler(async (req, res) => {
  const applications = await applicationService.getAllApplications();
  const filtered = req.query.status
    ? applications.filter((application) => application.status === req.query.status)
    : applications;
  const formatted = filtered.map((application) => ({
    id: application.id,
    applicantName: application.name,
    applicantEmail: application.email,
    status: application.status,
    submittedAt: application.createdAt,
    feePaid: application.feePaid,
    paymentVerifiedAt: application.paymentVerifiedAt,
    rejectedReason: application.rejectedReason,
  }));

  return ResponseHandler.success(res, formatted, 'Applications retrieved successfully', 200);
});

const reviewApplication = asyncHandler(async (req, res) => {
  const { status, notes } = req.body;
  if (!status) {
    throw new ValidationError('Review status is required');
  }

  if (status !== 'APPROVED' && status !== 'REJECTED') {
    throw new ValidationError('Status must be APPROVED or REJECTED');
  }

  if (status === 'APPROVED') {
    const result = await applicationService.approveApplication(req.params.applicationId, req.user.id);
    return ResponseHandler.success(res, {
      user: UserDTO.admin(result.user),
      member: formatMember(result.member),
    }, 'Application approved successfully', 200);
  }

  const result = await applicationService.rejectApplication(req.params.applicationId, notes || 'No reason provided');
  return ResponseHandler.success(res, result, 'Application rejected successfully', 200);
});

const getSystemStats = asyncHandler(async (req, res) => {
  const totalMembers = await db.User.count({ where: { role: 'MEMBER' } });
  const pendingApplications = await db.MembershipApplication.count({ where: { status: { [Op.in]: ['PENDING_PAYMENT', 'PENDING_APPROVAL'] } } });
  const activeLoans = await db.Loan.count({ where: { status: 'ACTIVE' } });
  const totalSharesValueResult = await db.ShareAccount.findAll({ attributes: ['shares', 'shareValue'] });
  const totalShares = totalSharesValueResult.reduce((sum, account) => sum + (account.shares * account.shareValue), 0);
  const deposits = await db.Transaction.sum('amount', { where: { type: 'DEPOSIT', status: 'SUCCESS' } }) || 0;
  const withdrawals = await db.Transaction.sum('amount', { where: { type: 'WITHDRAWAL', status: 'SUCCESS' } }) || 0;
  const loansDisbursed = await db.Transaction.sum('amount', { where: { type: 'LOAN_DISBURSEMENT', status: 'SUCCESS' } }) || 0;
  const dividends = await db.Dividend.sum('amount') || 0;

  return ResponseHandler.success(res, {
    totalMembers,
    pendingApplications,
    activeLoans,
    totalShares,
    deposits,
    withdrawals,
    loansDisbursed,
    dividends,
  }, 'System stats retrieved successfully', 200);
});

const listNotifications = asyncHandler(async (req, res) => {
  const notifications = await notificationService.listForUser(req.user, {
    unreadOnly: req.query.unreadOnly === 'true',
    limit: req.query.limit,
  });
  return ResponseHandler.success(res, notifications, 'Notifications retrieved successfully', 200);
});

const markNotificationRead = asyncHandler(async (req, res) => {
  const notification = await notificationService.markRead(req.user, req.params.notificationId);
  return ResponseHandler.success(res, notification, 'Notification marked as read', 200);
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  await notificationService.markAllRead(req.user);
  return ResponseHandler.success(res, null, 'Notifications marked as read', 200);
});

const normalizeManualNotificationPayload = (body = {}, audience) => ({
  title: body.title,
  body: body.body || body.message,
  audience,
  recipientUserId: body.recipientUserId,
  category: body.category || 'announcement',
  severity: body.severity || 'info',
  actionUrl: body.actionUrl || null,
  metadata: body.metadata || {},
});

const resolveNotificationRecipientUserId = async (body = {}) => {
  const key = String(body.recipientUserId || body.userId || body.memberId || body.memberNumber || body.email || '').trim();
  if (!key) throw new ValidationError('Recipient member ID, member number, user ID, or email is required');

  let member = await db.Member.findOne({
    where: {
      [Op.or]: [
        { id: key },
        { memberNumber: key },
      ],
    },
    include: [{ model: db.User, attributes: ['id', 'email', 'role'] }],
  });

  if (!member) {
    member = await db.Member.findOne({
      include: [{ model: db.User, where: { [Op.or]: [{ id: key }, { email: key }] }, attributes: ['id', 'email', 'role'] }],
    });
  }

  if (!member?.User || member.User.role !== 'MEMBER') throw new NotFoundError('Selected member was not found');
  return member.User.id;
};

const sendBroadcastNotification = asyncHandler(async (req, res) => {
  const result = await notificationService.createManualNotification(req.user, normalizeManualNotificationPayload(req.body, req.body?.audience || 'ALL'));
  return ResponseHandler.created(res, result, 'Broadcast notification sent successfully');
});

const sendDirectNotification = asyncHandler(async (req, res) => {
  const recipientUserId = await resolveNotificationRecipientUserId(req.body);
  const result = await notificationService.createManualNotification(req.user, normalizeManualNotificationPayload({ ...req.body, recipientUserId }, 'INDIVIDUAL'));
  return ResponseHandler.created(res, result, 'Direct notification sent successfully');
});

const normalizePortfolioYear = (value) => {
  const year = Number(value || new Date().getFullYear() - 1);
  if (!Number.isInteger(year) || year < 2000 || year > new Date().getFullYear() + 1) {
    throw new ValidationError('Enter a valid financial year');
  }
  return year;
};

const serializeReportRow = (row) => ({
  id: row.id,
  year: row.year,
  category: row.category,
  amount: Number(row.amount || 0),
  percentageUsed: Number(row.percentageUsed || 0),
  metadata: row.metadata || {},
  updatedAt: row.updatedAt,
});

const serializePortfolioAnchor = (anchor) => {
  const metadata = anchor?.metadata || {};
  return {
    id: anchor?.id || null,
    year: anchor?.year || null,
    metrics: {
      totalAmount: Number(metadata.metrics?.totalAmount || 0),
      interestEarned: Number(metadata.metrics?.interestEarned || 0),
      investments: Number(metadata.metrics?.investments || 0),
      memberGrowthRate: Number(metadata.metrics?.memberGrowthRate || 0),
    },
    chartData: Array.isArray(metadata.chartData) ? metadata.chartData : [],
    imageUrl: metadata.imageUrl || '',
    bannerUrl: metadata.bannerUrl || metadata.imageUrl || '',
    updatedAt: anchor?.updatedAt || null,
  };
};

const serializeDividendRow = (row) => ({
  id: row.id,
  userId: row.userId,
  financialYearId: row.financialYearId,
  totalShares: Number(row.totalShares || 0),
  dividendPaid: Number(row.dividendPaid || 0),
  member: row.User ? {
    id: row.User.id,
    name: row.User.name,
    email: row.User.email,
    memberNumber: row.User.Member?.memberNumber || '',
  } : null,
  updatedAt: row.updatedAt,
});

const getPortfolioYearAnchor = async (year, transaction = null) => {
  const [anchor] = await db.FinancialYearReport.findOrCreate({
    where: { year, category: '__YEAR__' },
    defaults: { amount: 0, percentageUsed: 0, metadata: { hidden: true } },
    transaction,
  });
  return anchor;
};

const loadFinancialPortfolioPayload = async ({ year, userId = null, includeDividends = false }) => {
  let targetYear = year;
  let anchor = null;
  if (targetYear) {
    anchor = await getPortfolioYearAnchor(targetYear);
  } else {
    anchor = await db.FinancialYearReport.findOne({
      where: { category: '__YEAR__' },
      order: [['year', 'DESC']],
    });
    if (!anchor) anchor = await getPortfolioYearAnchor(new Date().getFullYear() - 1);
    targetYear = anchor.year;
  }

  const reportRows = await db.FinancialYearReport.findAll({
    where: { year: targetYear, category: { [Op.ne]: '__YEAR__' } },
    order: [['category', 'ASC']],
  });

  let dividend = null;
  if (userId) {
    dividend = await db.MemberDividend.findOne({ where: { userId, financialYearId: anchor.id } });
  }

  let dividends = [];
  if (includeDividends) {
    dividends = await db.MemberDividend.findAll({
      where: { financialYearId: anchor.id },
      include: [{ model: db.User, attributes: ['id', 'name', 'email'], include: [{ model: db.Member, attributes: ['memberNumber'] }] }],
      order: [[db.User, 'name', 'ASC']],
      limit: 1000,
    });
  }

  return {
    year: targetYear,
    portfolio: serializePortfolioAnchor(anchor),
    reports: reportRows.map(serializeReportRow),
    investmentCategories: reportRows.map(serializeReportRow),
    dividend: dividend ? {
      id: dividend.id,
      totalShares: Number(dividend.totalShares || 0),
      dividendPaid: Number(dividend.dividendPaid || 0),
      updatedAt: dividend.updatedAt,
    } : null,
    dividends: dividends.map(serializeDividendRow),
  };
};

const getFinancialPortfolio = asyncHandler(async (req, res) => {
  const year = normalizePortfolioYear(req.query.year);
  const payload = await loadFinancialPortfolioPayload({ year, includeDividends: true });
  return ResponseHandler.success(res, payload, 'Financial portfolio retrieved', 200);
});

const savePortfolioPayload = async ({ year, metrics = {}, categories = [], imageUrl = '', bannerUrl = '', chartData = [] }) => {
  if (!categories.length) throw new ValidationError('At least one investment category is required');
  const saved = [];
  await db.sequelize.transaction(async (transaction) => {
    const anchor = await getPortfolioYearAnchor(year, transaction);
    await anchor.update({
      metadata: {
        ...(anchor.metadata || {}),
        hidden: true,
        metrics: {
          totalAmount: toNumber(metrics.totalAmount),
          interestEarned: toNumber(metrics.interestEarned),
          investments: toNumber(metrics.investments),
          memberGrowthRate: toNumber(metrics.memberGrowthRate),
        },
        imageUrl: String(imageUrl || bannerUrl || '').trim(),
        bannerUrl: String(bannerUrl || imageUrl || '').trim(),
        chartData: Array.isArray(chartData) ? chartData : [],
      },
    }, { transaction });

    for (const item of categories) {
      const category = String(item.category || item.label || '').trim();
      const amount = toNumber(item.amount);
      const percentageUsed = toNumber(item.percentageUsed ?? item.percentage_used ?? item.percentage);
      if (!category) throw new ValidationError('Each investment row requires a category');
      if (amount < 0 || percentageUsed < 0 || percentageUsed > 100) throw new ValidationError('Amounts must be positive and percentages must be between 0 and 100');
      const [row] = await db.FinancialYearReport.findOrCreate({
        where: { year, category },
        defaults: { amount, percentageUsed, metadata: item.metadata || {} },
        transaction,
      });
      await row.update({ amount, percentageUsed, metadata: item.metadata || row.metadata || {} }, { transaction });
      saved.push(row);
    }
  });
  return saved;
};

const upsertFinancialPortfolioReports = asyncHandler(async (req, res) => {
  const year = normalizePortfolioYear(req.params.year || req.body?.year);
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
  const saved = await savePortfolioPayload({
    year,
    metrics: req.body?.metrics || {},
    categories,
    imageUrl: req.body?.imageUrl,
    bannerUrl: req.body?.bannerUrl,
    chartData: req.body?.chartData,
  });
  return ResponseHandler.success(res, { year, reports: saved.map(serializeReportRow) }, 'Financial usage breakdown saved', 200);
});

const upsertPortfolio = asyncHandler(async (req, res) => {
  const year = normalizePortfolioYear(req.body?.year || req.params.year);
  const categories = Array.isArray(req.body?.investmentCategories)
    ? req.body.investmentCategories
    : Array.isArray(req.body?.categories)
      ? req.body.categories
      : [];
  await savePortfolioPayload({
    year,
    metrics: req.body?.metrics || {},
    categories,
    imageUrl: req.body?.imageUrl,
    bannerUrl: req.body?.bannerUrl,
    chartData: req.body?.chartData,
  });
  const payload = await loadFinancialPortfolioPayload({ year, includeDividends: true });
  return ResponseHandler.success(res, payload, 'Portfolio report saved', 200);
});

const mapDividendImportRow = (row) => ({
  rowNumber: row.rowNumber,
  memberNumber: pick(row, ['memberNumber', 'memberNo', 'memberId', 'membershipId']),
  email: pick(row, ['email', 'emailAddress']).toLowerCase(),
  userId: pick(row, ['userId', 'user_id']),
  totalShares: toNumber(pick(row, ['totalShares', 'shares', 'sharesHeld'])),
  dividendPaid: toNumber(pick(row, ['dividendPaid', 'dividend', 'amount', 'dividendAmount'])),
});

const upsertMemberDividends = asyncHandler(async (req, res) => {
  const year = normalizePortfolioYear(req.params.year || req.body?.year);
  const rawRows = Array.isArray(req.body?.dividends)
    ? req.body.dividends.map((row, index) => ({ rowNumber: index + 1, ...row }))
    : parseCsv(req.body?.csv).map(mapDividendImportRow);
  if (!rawRows.length) throw new ValidationError('No dividend rows supplied');

  const imported = [];
  const skipped = [];
  await db.sequelize.transaction(async (transaction) => {
    const anchor = await getPortfolioYearAnchor(year, transaction);
    for (const raw of rawRows) {
      const row = raw.raw ? mapDividendImportRow(raw) : raw;
      const key = String(row.userId || row.memberNumber || row.email || '').trim();
      if (!key) {
        skipped.push({ rowNumber: row.rowNumber, reason: 'Missing member identifier' });
        continue;
      }
      const member = await db.Member.findOne({
        where: row.memberNumber ? { memberNumber: row.memberNumber } : undefined,
        include: [{ model: db.User, where: row.userId ? { id: row.userId } : row.email ? { email: row.email } : undefined }],
        transaction,
      });
      if (!member?.User) {
        skipped.push({ rowNumber: row.rowNumber, reason: 'Member not found', key });
        continue;
      }
      const totalShares = Number(row.totalShares || 0);
      const dividendPaid = Number(row.dividendPaid || 0);
      if (totalShares < 0 || dividendPaid < 0) {
        skipped.push({ rowNumber: row.rowNumber, reason: 'Shares and dividend must be positive', key });
        continue;
      }
      const [dividend] = await db.MemberDividend.findOrCreate({
        where: { userId: member.User.id, financialYearId: anchor.id },
        defaults: { totalShares, dividendPaid, metadata: { memberNumber: member.memberNumber } },
        transaction,
      });
      await dividend.update({ totalShares, dividendPaid, metadata: { ...(dividend.metadata || {}), memberNumber: member.memberNumber } }, { transaction });
      imported.push({ rowNumber: row.rowNumber, userId: member.User.id, memberNumber: member.memberNumber, totalShares, dividendPaid });
    }
  });

  return ResponseHandler.success(res, { year, imported, skipped }, 'Member dividends saved', 200);
});

const saveDividendImportRows = async ({ rows, year }) => {
  const imported = [];
  const skipped = [];
  const targetYear = normalizePortfolioYear(year || rows.find((row) => row.data?.financialYear)?.data?.financialYear);

  await db.sequelize.transaction(async (transaction) => {
    const anchor = await getPortfolioYearAnchor(targetYear, transaction);
    for (const row of rows) {
      const data = row.data || {};
      let member = null;
      if (data.memberNumber) member = await db.Member.findOne({ where: { memberNumber: data.memberNumber }, include: [{ model: db.User }], transaction });
      if (!member && data.email) member = await db.Member.findOne({ include: [{ model: db.User, where: { email: data.email } }], transaction });
      if (!member && data.staffId) member = await db.Member.findOne({ include: [{ model: db.User, where: { staffId: data.staffId } }], transaction });
      if (!member?.User) {
        skipped.push({ rowNumber: row.rowNumber, sheetName: data.sheetName, reason: 'Member not found', key: data.memberNumber || data.email || data.staffId });
        continue;
      }

      const totalShares = Number(data.totalShares || data.shareCapital || 0);
      const dividendPaid = Number(data.dividendPaid || 0);
      if (totalShares < 0 || dividendPaid < 0 || (!totalShares && !dividendPaid)) {
        skipped.push({ rowNumber: row.rowNumber, sheetName: data.sheetName, reason: 'Missing dividend shares/amount', key: member.memberNumber });
        continue;
      }

      const [dividend] = await db.MemberDividend.findOrCreate({
        where: { userId: member.User.id, financialYearId: anchor.id },
        defaults: { totalShares, dividendPaid, metadata: { memberNumber: member.memberNumber, sourceSheet: data.sheetName || null, importedBy: 'financial_csv' } },
        transaction,
      });
      await dividend.update({
        totalShares,
        dividendPaid,
        metadata: { ...(dividend.metadata || {}), memberNumber: member.memberNumber, sourceSheet: data.sheetName || null, importedBy: 'financial_csv' },
      }, { transaction });
      imported.push({ rowNumber: row.rowNumber, sheetName: data.sheetName, userId: member.User.id, memberNumber: member.memberNumber, totalShares, dividendPaid });
    }
  });

  return { year: targetYear, imported, skipped };
};

const previewMemberCsvImport = asyncHandler(async (req, res) => {
  const rows = parseCsv(req.body?.csv);
  if (!rows.length) throw new ValidationError('CSV file is empty or missing headers');
  const preview = rows.map(mapMemberImportRow);
  return ResponseHandler.success(res, {
    rows: preview,
    readyCount: preview.filter((row) => row.ready).length,
    errorCount: preview.filter((row) => !row.ready).length,
  }, 'Member import preview generated', 200);
});

const commitMemberCsvImport = asyncHandler(async (req, res) => {
  const rows = parseCsv(req.body?.csv).map(mapMemberImportRow);
  const readyRows = rows.filter((row) => row.ready);
  if (!readyRows.length) throw new ValidationError('No valid member rows to import');

  const imported = [];
  const skipped = [];
  for (const row of readyRows) {
    const { data } = row;
    const existingUser = await db.User.findOne({ where: { email: data.email } });
    if (existingUser) {
      skipped.push({ rowNumber: row.rowNumber, email: data.email, reason: 'Email already exists' });
      continue;
    }
    const password = '12345678';
    const hashedPassword = await bcrypt.hash(password, 10);
    const isStaffMember = hasStaffId(data.staffId);
    const result = await db.sequelize.transaction(async (transaction) => {
      const user = await db.User.create({
        name: data.fullName,
        email: data.email,
        phone: data.phone,
        nationalId: data.nationalId,
        password: hashedPassword,
        role: 'MEMBER',
        isVerified: true,
        employer: 'Ayedos',
        staffId: data.staffId || null,
        payrollNumber: data.staffId || null,
        mustChangePassword: true,
        isWhitelisted: true,
        consentGiven: true,
        consentGivenAt: new Date(),
      }, { transaction });
      const member = await db.Member.create({
        userId: user.id,
        memberNumber: data.memberNumber || `AYEDOS-${Date.now()}-${String(user.id).slice(0, 6).toUpperCase()}`,
        type: isStaffMember ? 'EMPLOYEE' : 'NON_EMPLOYEE',
        nationalId: data.nationalId,
        shareCapital: data.shareCapital,
        savings: data.savings,
        status: data.status || 'ACTIVE',
        isVerified: true,
        dateJoined: data.joinDate ? new Date(data.joinDate) : new Date(),
      }, { transaction });
      await db.SavingsAccount.create({ memberId: member.id, balance: data.savings }, { transaction });
      await db.ShareAccount.create({ memberId: member.id, shares: data.shareCapital / 100, shareValue: 100 }, { transaction });
      return { user, member };
    });
    imported.push({
      rowNumber: row.rowNumber,
      userId: result.user.id,
      memberId: result.member.id,
      memberNumber: result.member.memberNumber,
      email: data.email,
    });
  }

  return ResponseHandler.success(res, { imported, skipped }, 'Members imported successfully', 201);
});

const previewFinancialCsvImport = asyncHandler(async (req, res) => {
  const rows = parseCsv(req.body?.csv);
  if (!rows.length) throw new ValidationError('CSV file is empty or missing headers');
  const preview = rows.map(mapFinancialImportRow);
  const dividendRows = preview.filter(isDividendImportRow);
  return ResponseHandler.success(res, {
    rows: preview,
    dividendRows,
    readyCount: preview.filter((row) => row.ready).length,
    dividendReadyCount: dividendRows.filter((row) => row.ready).length,
    errorCount: preview.filter((row) => !row.ready).length,
  }, 'Financial import preview generated', 200);
});

const commitFinancialCsvImport = asyncHandler(async (req, res) => {
  const mappedRows = parseCsv(req.body?.csv).map(mapFinancialImportRow);
  const rows = mappedRows.filter((row) => row.ready);
  if (!rows.length) throw new ValidationError('No valid financial rows to import');
  const imported = [];
  const skipped = [];
  const dividendResult = await saveDividendImportRows({ rows: rows.filter(isDividendImportRow), year: req.body?.year });

  for (const row of rows) {
    if (isDividendImportRow(row) && !Number(row.data.savings || 0) && !Number(row.data.shareCapital || 0) && !Number(row.data.loans || 0) && !Number(row.data.loanRepayment || 0) && !Number(row.data.interest || 0) && !Number(row.data.employerContribution || 0)) {
      continue;
    }
    const { data } = row;
    let member = null;
    if (data.memberNumber) {
      member = await db.Member.findOne({ where: { memberNumber: data.memberNumber }, include: [{ model: db.User }] });
    }
    if (!member && data.email) {
      member = await db.Member.findOne({ include: [{ model: db.User, where: { email: data.email } }] });
    }
    if (!member && data.staffId) {
      member = await db.Member.findOne({ include: [{ model: db.User, where: { staffId: data.staffId } }] });
    }
    if (!member) {
      skipped.push({ rowNumber: row.rowNumber, reason: 'Member not found', key: data.memberNumber || data.email || data.staffId });
      continue;
    }

    const isStaffMember = hasStaffId(member.User?.staffId || data.staffId);
    const employerContribution = isStaffMember ? data.employerContribution : 0;
    await db.sequelize.transaction(async (transaction) => {
      await member.update({
        shareCapital: data.shareCapital,
        savings: data.savings,
        loans: data.loans,
        loanRepayment: data.loanRepayment,
        interest: data.interest,
        employerContribution,
      }, { transaction });
      if (member.User) {
        await member.User.update({
          employerContribution,
          staffId: isStaffMember ? (data.staffId || member.User.staffId) : null,
          payrollNumber: isStaffMember ? (data.staffId || member.User.payrollNumber) : null,
        }, { transaction });
      }
      const [savingsAccount] = await db.SavingsAccount.findOrCreate({ where: { memberId: member.id }, defaults: { balance: 0 }, transaction });
      await savingsAccount.update({ balance: data.savings }, { transaction });
      const [shareAccount] = await db.ShareAccount.findOrCreate({ where: { memberId: member.id }, defaults: { shares: 0, shareValue: 100 }, transaction });
      await shareAccount.update({ shares: data.shareCapital / Number(shareAccount.shareValue || 100) }, { transaction });

      const importReference = `CSV-${member.memberNumber}-${Date.now()}-${row.rowNumber}`;
      const transactionRows = [
        ['DEPOSIT', data.savings, 'historical_savings'],
        ['DEPOSIT', data.shareCapital, 'share_capital'],
        ['DEPOSIT', employerContribution, 'employer_contribution'],
        ['LOAN_REPAYMENT', data.loanRepayment, 'loan_repayment'],
      ].filter(([, amount]) => Number(amount) > 0);
      for (const [type, amount, category] of transactionRows) {
        await db.Transaction.create({
          memberId: member.id,
          type,
          amount,
          method: 'MANUAL',
          status: 'SUCCESS',
          reference: `${importReference}-${category}`,
          description: `${data.sheetName ? `${data.sheetName} ` : ''}import ${category}`,
          paymentCategory: category,
        }, { transaction });
      }
    });
    imported.push({ rowNumber: row.rowNumber, sheetName: data.sheetName, memberId: member.id, memberNumber: member.memberNumber });
  }
  return ResponseHandler.success(res, { imported, skipped, dividends: dividendResult }, 'Financial records imported successfully', 201);
});

module.exports = {
  getAllUsers,
  getArchivedMembers,
  getAuditLogs,
  getUserById,
  updateUserRole,
  updateUserStatus,
  getAllApplications,
  reviewApplication,
  getSystemStats,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  sendBroadcastNotification,
  sendDirectNotification,
  getFinancialPortfolio,
  upsertFinancialPortfolioReports,
  upsertPortfolio,
  upsertMemberDividends,
  previewMemberCsvImport,
  commitMemberCsvImport,
  previewFinancialCsvImport,
  commitFinancialCsvImport,
};
