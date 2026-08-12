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

const parseCsv = (csvText = '') => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const text = String(csvText || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
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

const mapMemberImportRow = (row) => {
  const fullName = pick(row, ['name', 'fullName', 'memberName']);
  const email = pick(row, ['email', 'emailAddress', 'username']).toLowerCase();
  const phone = pick(row, ['phone', 'phoneNumber', 'mobile']);
  const nationalId = pick(row, ['nationalId', 'nationalID', 'idNumber']);
  const memberNumber = pick(row, ['memberNumber', 'registrationNumber', 'memberNo']);
  const staffId = pick(row, ['staffId', 'staffID', 'payrollNumber', 'employeeId']);
  const status = pick(row, ['status']) || 'ACTIVE';
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
      status: status.toUpperCase(),
      company: 'Ayedos',
      isWhitelisted: true,
    },
  };
};

const mapFinancialImportRow = (row) => {
  const sheetName = pick(row, ['sheet', 'worksheet', 'workbookSheet']);
  const memberNumber = pick(row, ['memberNumber', 'registrationNumber', 'memberNo']);
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
    },
  };
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

const getAllUsers = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsers();
  return ResponseHandler.success(res, users.map(UserDTO.admin), 'Users retrieved successfully', 200);
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
    const password = data.email.replace(/@/g, '');
    const hashedPassword = await bcrypt.hash(password, 10);
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
        isWhitelisted: true,
        consentGiven: true,
        consentGivenAt: new Date(),
      }, { transaction });
      const member = await db.Member.create({
        userId: user.id,
        memberNumber: data.memberNumber || `AYEDOS-${Date.now()}-${String(user.id).slice(0, 6).toUpperCase()}`,
        type: 'EMPLOYEE',
        nationalId: data.nationalId,
        status: data.status || 'ACTIVE',
        isVerified: true,
        dateJoined: new Date(),
      }, { transaction });
      await db.SavingsAccount.create({ memberId: member.id }, { transaction });
      await db.ShareAccount.create({ memberId: member.id }, { transaction });
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
  return ResponseHandler.success(res, {
    rows: preview,
    readyCount: preview.filter((row) => row.ready).length,
    errorCount: preview.filter((row) => !row.ready).length,
  }, 'Financial import preview generated', 200);
});

const commitFinancialCsvImport = asyncHandler(async (req, res) => {
  const rows = parseCsv(req.body?.csv).map(mapFinancialImportRow).filter((row) => row.ready);
  if (!rows.length) throw new ValidationError('No valid financial rows to import');
  const imported = [];
  const skipped = [];

  for (const row of rows) {
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

    await db.sequelize.transaction(async (transaction) => {
      await member.update({
        shareCapital: data.shareCapital,
        savings: data.savings,
        loans: data.loans,
        loanRepayment: data.loanRepayment,
        interest: data.interest,
        employerContribution: data.employerContribution,
      }, { transaction });
      if (member.User) {
        await member.User.update({
          employerContribution: data.employerContribution,
          staffId: data.staffId || member.User.staffId,
          payrollNumber: data.staffId || member.User.payrollNumber,
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
        ['DEPOSIT', data.employerContribution, 'employer_contribution'],
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
  return ResponseHandler.success(res, { imported, skipped }, 'Financial records imported successfully', 201);
});

module.exports = {
  getAllUsers,
  getUserById,
  updateUserRole,
  updateUserStatus,
  getAllApplications,
  reviewApplication,
  getSystemStats,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  previewMemberCsvImport,
  commitMemberCsvImport,
  previewFinancialCsvImport,
  commitFinancialCsvImport,
};
