const db = require('../../../models');
const { Op } = require('sequelize');
const userService = require('../../users/services/userService');
const applicationService = require('../../applications/services/applicationService');
const identityVerificationService = require('../../applications/services/identityVerificationService');
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
  const number = Number(String(value || '').replace(/,/g, '').replace(/-/g, '').trim());
  return Number.isFinite(number) ? number : 0;
};

const hasStaffId = (value) => Boolean(String(value || '').trim());
const normalizeMemberStatus = (status) => String(status || 'ACTIVE').trim().toUpperCase();
const isExitedMemberStatus = (status) => ['EXITED', 'INACTIVE', 'CLOSED', 'RESIGNED', 'WITHDRAWN', 'DECEASED'].includes(normalizeMemberStatus(status));
const shouldCreateMemberAccount = (status) => normalizeMemberStatus(status) === 'ACTIVE';
const parseJsonCell = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
const optionalStringField = (key, value) => {
  const normalized = String(value || '').trim();
  return normalized ? { [key]: normalized } : {};
};
const EMPLOYEE_TAG = 'EMPLOYEE';

const mergeImportProfile = (member, data, status) => ({
  ...(member?.importProfile || {}),
  fullName: data.fullName,
  email: data.email || member?.importProfile?.email || null,
  phone: data.phone || member?.importProfile?.phone || null,
  staffId: data.staffId || member?.importProfile?.staffId || null,
  status,
  statementSheet: data.statementSheet || member?.importProfile?.statementSheet || null,
  statementDetails: data.statementDetails || member?.importProfile?.statementDetails || null,
  source: 'bulk_member_import',
  raw: data.raw || member?.importProfile?.raw || {},
  lastImportedAt: new Date().toISOString(),
});

const normalizeImportReferencePart = (value) => String(value || '')
  .trim()
  .replace(/[^a-z0-9]+/gi, '-')
  .replace(/^-+|-+$/g, '')
  .toUpperCase() || 'NA';

const buildImportReference = ({ member, data = {}, category, amount, rowNumber }) => [
  'IMPORT',
  normalizeImportReferencePart(member.memberNumber || member.id),
  normalizeImportReferencePart(category),
  normalizeImportReferencePart(data.sheetName || data.statementSheet || data.raw?.['Statement Sheet']),
  normalizeImportReferencePart(rowNumber),
  normalizeImportReferencePart(Number(amount || 0).toFixed(2)),
].join('-').slice(0, 255);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

const createBalanceDeltaTransaction = async ({ memberId, loanId, type, amount, category, description, rowNumber, transaction, reference = null, metadata = null }) => {
  const normalizedAmount = Math.abs(Number(amount || 0));
  if (!normalizedAmount) return null;
  return db.Transaction.create({
    memberId,
    loanId: loanId || null,
    type,
    amount: normalizedAmount,
    method: 'MANUAL',
    status: 'SUCCESS',
    reference: reference || `IMPORT-${memberId}-${category}-${Date.now()}-${rowNumber}`,
    description,
    paymentCategory: category,
    internalReference: metadata ? JSON.stringify(metadata).slice(0, 255) : null,
  }, { transaction });
};

const syncImportedMembershipFee = async ({ member, data, rowNumber, transaction }) => {
  const amount = Number(data.membershipFee || 0);
  if (!amount) return null;
  const reference = buildImportReference({ member, data, category: 'membership_fee', amount, rowNumber });
  const existing = await db.Transaction.findOne({
    where: {
      memberId: member.id,
      type: 'MEMBERSHIP_FEE',
      amount,
      paymentCategory: 'membership_fee',
      reference,
    },
    transaction,
  });
  if (existing) {
    await existing.update({
      status: 'SUCCESS',
      description: 'Imported membership fee',
    }, { transaction });
    return existing;
  }
  return createBalanceDeltaTransaction({
    memberId: member.id,
    type: 'MEMBERSHIP_FEE',
    amount,
    category: 'membership_fee',
    description: 'Imported membership fee',
    rowNumber,
    reference,
    metadata: { source: 'membership_fee_sheet', rowNumber, sheetName: data.sheetName || data.statementSheet || 'Bio data' },
    transaction,
  });
};

const syncImportedMemberBalances = async ({ member, data, rowNumber, transaction }) => {
  const [savingsAccount] = await db.SavingsAccount.findOrCreate({
    where: { memberId: member.id },
    defaults: { balance: 0 },
    transaction,
  });
  const [shareAccount] = await db.ShareAccount.findOrCreate({
    where: { memberId: member.id },
    defaults: { shares: 0, shareValue: 100 },
    transaction,
  });

  const shareValue = Number(shareAccount.shareValue || 100);
  const adjustments = [
    { key: 'savings', target: Number(data.savings || 0), current: Number(savingsAccount.balance || 0), type: 'DEPOSIT', category: 'historical_savings', description: 'Imported member statement savings balance adjustment' },
    { key: 'shareCapital', target: Number(data.shareCapital || 0), current: Number(shareAccount.shares || 0) * shareValue, type: 'DEPOSIT', category: 'share_capital', description: 'Imported member statement share capital balance adjustment' },
    { key: 'employerContribution', target: Number(data.employerContribution || 0), current: Number(member.employerContribution || 0), type: 'DEPOSIT', category: 'employer_contribution', description: 'Imported member statement employer contribution balance adjustment' },
  ];

  for (const adjustment of adjustments) {
    const delta = adjustment.target - adjustment.current;
    const reference = buildImportReference({ member, data, category: adjustment.category, amount: adjustment.target, rowNumber });
    const duplicate = await db.Transaction.findOne({
      where: {
        memberId: member.id,
        paymentCategory: adjustment.category,
        reference,
      },
      transaction,
    });
    if (duplicate) {
      await duplicate.update({ status: 'SUCCESS', description: adjustment.description }, { transaction });
      continue;
    }
    if (!delta) continue;
    await createBalanceDeltaTransaction({
      memberId: member.id,
      type: delta >= 0 ? 'DEPOSIT' : 'WITHDRAWAL',
      amount: delta,
      category: adjustment.category,
      description: adjustment.description,
      rowNumber,
      reference,
      metadata: { source: 'financial_import', rowNumber, sheetName: data.sheetName || data.statementSheet || null },
      transaction,
    });
  }

  const targetSavings = hasOwn(data, 'savings') ? Number(data.savings || 0) : Number(savingsAccount.balance || 0);
  const targetShareCapital = hasOwn(data, 'shareCapital') ? Number(data.shareCapital || 0) : (Number(shareAccount.shares || 0) * shareValue);
  const targetEmployerContribution = hasOwn(data, 'employerContribution') ? Number(data.employerContribution || 0) : Number(member.employerContribution || 0);
  await savingsAccount.update({ balance: targetSavings }, { transaction });
  await shareAccount.update({ shares: targetShareCapital / shareValue }, { transaction });
  await member.update({
    shareCapital: targetShareCapital,
    savings: targetSavings,
    employerContribution: targetEmployerContribution,
  }, { transaction });
};

const syncImportedLoanLiability = async ({ member, data, rowNumber, transaction }) => {
  const importedLoanBalance = Number(data.loans || 0);
  const importedRepayment = Number(data.loanRepayment || 0);
  const existingLoan = await db.Loan.findOne({
    where: {
      memberId: member.id,
      reason: 'Imported account liability statement',
    },
    transaction,
  });
  if (!importedLoanBalance && !importedRepayment && !existingLoan) return null;
  const loan = existingLoan || await db.Loan.create({
    memberId: member.id,
    amount: 0,
    principalBalance: 0,
    accruedInterest: 0,
    interestRate: 0,
    duration: 1,
    reason: 'Imported account liability statement',
    status: 'ACTIVE',
    type: 'DEVELOPMENT',
    approvalStage: 'FINANCE',
    decidedAt: new Date(),
  }, { transaction });
  let currentBalance = Number(loan.principalBalance ?? loan.amount ?? 0);
  if (hasOwn(data, 'loans')) {
    const delta = importedLoanBalance - currentBalance;
    const reference = buildImportReference({ member, data, category: 'account_liability_statement', amount: importedLoanBalance, rowNumber });
    const duplicate = await db.Transaction.findOne({
      where: {
        memberId: member.id,
        loanId: loan.id,
        paymentCategory: 'account_liability_statement',
        reference,
      },
      transaction,
    });
    if (duplicate) {
      await duplicate.update({ status: 'SUCCESS', description: 'Imported account liability statement loan balance adjustment' }, { transaction });
    } else if (delta) {
      await createBalanceDeltaTransaction({
        memberId: member.id,
        loanId: loan.id,
        type: delta >= 0 ? 'LOAN_DISBURSEMENT' : 'LOAN_REPAYMENT',
        amount: delta,
        category: 'account_liability_statement',
        description: 'Imported account liability statement loan balance adjustment',
        rowNumber,
        reference,
        metadata: { source: 'account_liability_statement', rowNumber, sheetName: data.sheetName || data.statementSheet || null },
        transaction,
      });
    }
    currentBalance = importedLoanBalance;
  }
  if (importedRepayment > 0) {
    const repaymentAmount = importedRepayment;
    const reference = buildImportReference({ member, data, category: 'loan_repayment', amount: repaymentAmount, rowNumber });
    const duplicate = await db.Transaction.findOne({
      where: {
        memberId: member.id,
        loanId: loan.id,
        type: 'LOAN_REPAYMENT',
        amount: repaymentAmount,
        paymentCategory: 'loan_repayment',
        reference,
      },
      transaction,
    });
    if (duplicate) {
      await duplicate.update({ status: 'SUCCESS', description: `${data.sheetName ? `${data.sheetName} ` : ''}import loan repayment` }, { transaction });
    } else {
      currentBalance = Math.max(currentBalance - repaymentAmount, 0);
      await createBalanceDeltaTransaction({
        memberId: member.id,
        loanId: loan.id,
        type: 'LOAN_REPAYMENT',
        amount: repaymentAmount,
        category: 'loan_repayment',
        description: `${data.sheetName ? `${data.sheetName} ` : ''}import loan repayment`,
        rowNumber,
        reference,
        metadata: { source: 'financial_import', rowNumber, sheetName: data.sheetName || null },
        transaction,
      });
    }
  }
  await loan.update({
    amount: Math.max(Number(loan.amount || 0), currentBalance),
    principalBalance: currentBalance,
    status: currentBalance > 0 ? 'ACTIVE' : 'PAID',
  }, { transaction });
  await member.update({ loans: currentBalance }, { transaction });
  return loan;
};

const mapMemberImportRow = (row) => {
  const importedName = pick(row, ['name', 'fullName', 'full name', 'memberName', 'member name', 'memberNameFull', 'employeeName', 'employee name']);
  const email = pick(row, ['email', 'emailAddress', 'email address', 'username']).toLowerCase();
  const phone = pick(row, ['phone', 'phoneNumber', 'phone number', 'mobile', 'mobileNumber', 'mobile number', 'mobilePhoneNumber', 'mobile phone number', 'telephone']);
  const nationalId = pick(row, ['nationalId', 'nationalID', 'national id', 'idNumber', 'id number', 'idNo', 'id no', 'nationalIdentificationNumber', 'national identification number']);
  const memberNumber = pick(row, ['memberNumber', 'member number', 'memberNo', 'member no', 'memberNo.', 'member no.', 'registrationNumber', 'registration number', 'registrationNo', 'registration no', 'memberId', 'memberID']);
  const staffId = pick(row, ['staffId', 'staffID', 'payrollNumber', 'employeeId']);
  const status = normalizeMemberStatus(pick(row, ['status']) || 'ACTIVE');
  const shareCapital = toNumber(pick(row, ['shareCapital', 'share capital', 'currentShareCapital', 'current share capital', 'shares']));
  const membershipFee = toNumber(pick(row, ['membershipFee', 'membership fee', 'registrationFee', 'registration fee']));
  const savings = toNumber(pick(row, ['savings', 'personalSavings', 'personal savings', 'totalPersonalSavings', 'total personal savings', 'savingsBalance', 'savings balance']));
  const employerContribution = toNumber(pick(row, ['employerContribution', 'employer contribution', 'employerContrib']));
  const loans = toNumber(pick(row, ['loans', 'loanBalance', 'loan balance', 'liability', 'liabilityAmount', 'liability amount']));
  const joinDate = pick(row, ['joinDate', 'join date', 'joinedDate', 'joined date', 'dateJoined', 'date joined', 'joiningDate', 'joining date']);
  const statementSheet = pick(row, ['statementSheet', 'statement sheet', 'sheet']);
  const statementDetails = parseJsonCell(pick(row, ['statementDetails', 'statement details']));
  const fullName = importedName || statementDetails?.name || memberNumber || nationalId || 'Imported Employee';
  const createsAccount = shouldCreateMemberAccount(status);
  const missing = [];
  if (email && !/^\S+@\S+\.\S+$/.test(email)) missing.push('email');
  if (!nationalId) missing.push('nationalId');
  if (!memberNumber) missing.push('memberNumber');
  return {
    rowNumber: row.rowNumber,
    ready: missing.length === 0,
    missing,
    action: createsAccount ? 'CREATE_ACCOUNT' : 'RECORD_ONLY',
    data: {
      fullName,
      email,
      phone,
      nationalId,
      memberNumber,
      staffId,
      shareCapital,
      membershipFee,
      savings,
      employerContribution,
      loans,
      joinDate,
      status,
      exited: isExitedMemberStatus(status),
      createsAccount,
      statementSheet,
      statementDetails,
      company: 'Ayedos',
      isWhitelisted: true,
      raw: row.raw,
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
  const applicationIds = users.map((user) => user.Member?.applicationId).filter(Boolean);
  const applications = applicationIds.length
    ? await db.MembershipApplication.findAll({ where: { id: applicationIds }, attributes: ['id', 'status', 'feePaid', 'paymentVerifiedAt'] })
    : [];
  const applicationMap = new Map(applications.map((application) => [application.id, application]));
  const result = users.map((user) => {
    const row = UserDTO.admin(user);
    const member = row.Member || row.member;
    const application = member?.applicationId ? applicationMap.get(member.applicationId) : null;
    return {
      ...row,
      membershipComplete: Boolean(
        ['MEMBER', 'EMPLOYEE'].includes(row.role)
        && row.isVerified
        && member?.isVerified
        && String(member?.status || '').toUpperCase() === 'ACTIVE'
        && (!member.applicationId || (application?.status === 'APPROVED' && application?.feePaid && application?.paymentVerifiedAt)),
      ),
      onboardingStatus: application?.status || (member ? 'IMPORTED_MEMBER' : 'INCOMPLETE'),
    };
  });
  return ResponseHandler.success(res, result, 'Users retrieved successfully', 200);
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
  if (req.query.adminId) where.userId = String(req.query.adminId);
  if (req.query.dateFrom || req.query.dateTo) {
    where.createdAt = {};
    if (req.query.dateFrom) where.createdAt[Op.gte] = new Date(`${req.query.dateFrom}T00:00:00.000Z`);
    if (req.query.dateTo) where.createdAt[Op.lte] = new Date(`${req.query.dateTo}T23:59:59.999Z`);
  }
  const logs = await db.AuditLog.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
  });
  const actorIds = [...new Set(logs.map((log) => log.userId).filter(Boolean))];
  const [actors, auditMembers] = await Promise.all([
    actorIds.length ? db.User.findAll({ where: { id: actorIds }, attributes: ['id', 'name', 'firstName', 'lastName', 'role', 'staffId'] }) : [],
    db.Member.findAll({ attributes: ['id', 'userId', 'memberNumber'], include: [{ model: db.User, attributes: ['name', 'firstName', 'lastName'] }] }),
  ]);
  const actorMap = new Map(actors.map((actor) => [actor.id, actor]));
  const memberById = new Map(auditMembers.map((member) => [member.id, member]));
  const memberByUser = new Map(auditMembers.map((member) => [member.userId, member]));
  const normalized = logs.map((record) => {
    const log = typeof record.toJSON === 'function' ? record.toJSON() : record;
    const metadata = log.metadata || {};
    const actor = actorMap.get(log.userId);
    const params = metadata.params || {};
    const body = metadata.body || {};
    const targetId = metadata.targetId || params.loanId || params.memberId || params.userId || params.id || body.loanId || body.memberId || body.userId || '';
    const targetType = metadata.targetType || (String(log.route || '').match(/\/(loans|members|users|transactions|applications|roles|dividends|deductions)(?:\/|\?|$)/i)?.[1] || log.module || 'system').replace(/s$/, '').toUpperCase();
    const status = metadata.status || (log.statusCode >= 500 ? 'FAILED' : log.statusCode === 202 ? 'PENDING_APPROVAL' : log.statusCode >= 400 ? 'FAILED' : 'SUCCESS');
    const severity = metadata.severity || (log.statusCode >= 500 ? 'CRITICAL' : log.statusCode >= 400 ? 'WARN' : ['DELETE', 'LOAN_APPROVAL', 'PASSWORD_RESET'].some((term) => String(log.action).includes(term)) ? 'WARN' : 'INFO');
    const oldValue = metadata.oldValue ?? metadata.before ?? null;
    const newValue = metadata.newValue ?? metadata.after ?? (['POST', 'PUT', 'PATCH'].includes(log.method) ? body : null);
    const auditMember = memberById.get(body.memberId || params.memberId || targetId) || memberByUser.get(log.userId);
    const auditMemberName = auditMember?.User?.name || [auditMember?.User?.firstName, auditMember?.User?.lastName].filter(Boolean).join(' ');
    const category = metadata.category || (['loans', 'guarantors'].includes(String(log.module).toLowerCase()) ? 'Loan Management'
      : ['finance', 'transactions', 'payments', 'dividends', 'deductions'].includes(String(log.module).toLowerCase()) ? 'Financial'
        : ['member', 'members', 'applications'].includes(String(log.module).toLowerCase()) ? 'Member KYC'
          : ['auth', 'roles', 'users', 'admin'].includes(String(log.module).toLowerCase()) ? 'Access Control' : 'System');
    return {
      id: log.id,
      timestamp: new Date(log.createdAt).toISOString(),
      actorId: log.userId || 'SYSTEM',
      actorName: metadata.actorName || actor?.name || [actor?.firstName, actor?.lastName].filter(Boolean).join(' ') || 'System',
      actorRole: metadata.actorRole || actor?.role || 'SYSTEM',
      staffId: actor?.staffId || '—',
      sessionRef: metadata.sessionRef || 'Not recorded',
      event: log.action,
      category,
      targetType,
      targetId,
      target: targetId ? `${targetType}: ${targetId}` : targetType,
      memberNumber: metadata.memberNumber || body.memberNumber || auditMember?.memberNumber || '',
      memberName: metadata.memberName || body.memberName || auditMemberName || '',
      ipAddress: log.ip || '',
      device: metadata.device || log.userAgent || '',
      portal: metadata.portal || (log.route?.startsWith('/api/') ? 'Admin Portal / API' : 'System Job'),
      endpoint: `${log.method || ''} ${log.route || ''}`.trim(),
      location: metadata.location || 'Not available',
      beforeState: oldValue,
      afterState: newValue,
      stateDelta: oldValue !== null || newValue !== null ? `${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)}` : 'No state change captured',
      failureReason: status === 'FAILED' ? (metadata.error || metadata.failureReason || body.error || `Request failed with HTTP ${log.statusCode}`) : null,
      status,
      severity,
      method: log.method,
      route: log.route,
    };
  }).filter((log) => !req.query.severity || log.severity === String(req.query.severity).toUpperCase());
  const sessions = await db.LoginSession.findAll({
    where: { status: 'ACTIVE' },
    include: [{ model: db.User, attributes: ['role'] }],
    attributes: ['id'],
  });
  const activeAdminSessions = sessions.filter((session) => ['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(session.User?.role)).length;
  return ResponseHandler.success(res, { items: normalized, summary: { activeAdminSessions } }, 'Audit logs retrieved successfully', 200);
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
    name: application.name,
    email: application.email,
    phone: application.phone,
    nationalId: application.nationalId || application.identityNumber,
    identityType: application.identityType,
    memberType: application.type,
    occupation: application.occupation,
    county: application.county,
    onboardingStage: application.status === 'PENDING_PAYMENT' ? 'Payment' : application.status === 'PENDING_APPROVAL' ? 'Admin review' : 'Completed',
    status: ['PENDING_PAYMENT', 'PENDING_APPROVAL'].includes(application.status) ? 'PENDING' : application.status,
    applicationStatus: application.status,
    submittedDate: application.createdAt,
    feePaid: application.feePaid,
    paymentStatus: application.feePaid && application.paymentVerifiedAt ? 'PAID' : 'PENDING',
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
  const totalMembers = await db.User.count({ where: { role: { [Op.in]: ['MEMBER', 'EMPLOYEE'] } } });
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

const getBlockedIdentityAttempts = asyncHandler(async (req, res) => {
  const attempts = await identityVerificationService.listBlockedAttempts();
  return ResponseHandler.success(res, attempts, 'Blocked identity verification attempts retrieved successfully', 200);
});

const unblockIdentityAttempt = asyncHandler(async (req, res) => {
  const result = await identityVerificationService.unblockAttempt(req.params.attemptId, req.user);
  if (!result) throw new NotFoundError('Blocked identity attempt not found');
  return ResponseHandler.success(res, result, 'Identity verification block reset successfully', 200);
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
    try {
      const { data } = row;
      const existingMember = await db.Member.findOne({
      where: {
        [Op.or]: [
          ...(data.memberNumber ? [{ memberNumber: data.memberNumber }] : []),
          { nationalId: data.nationalId },
        ],
      },
      include: [{ model: db.User }],
    });
    if (existingMember) {
      const status = normalizeMemberStatus(data.status);
      let createdUser = null;
      if (!existingMember.User && shouldCreateMemberAccount(status)) {
        const existingUserForImport = await db.User.findOne({
          where: {
            [Op.or]: [
              ...(data.email ? [{ email: data.email }] : []),
              { nationalId: data.nationalId },
              ...(data.phone ? [{ phone: data.phone }] : []),
            ],
          },
        });
        if (existingUserForImport) {
          skipped.push({ rowNumber: row.rowNumber, memberNumber: data.memberNumber, reason: 'Matching user account already exists' });
          continue;
        }
        const hashedPassword = await bcrypt.hash('12345678', 10);
        createdUser = {
          name: data.fullName,
          ...optionalStringField('email', data.email),
          ...optionalStringField('phone', data.phone),
          nationalId: data.nationalId,
          password: hashedPassword,
          role: 'EMPLOYEE',
          isVerified: true,
          employer: 'Ayedos',
          staffId: data.staffId || null,
          payrollNumber: data.staffId || null,
          employmentTag: EMPLOYEE_TAG,
          employerContribution: data.employerContribution,
          mustChangePassword: true,
          isWhitelisted: true,
          consentGiven: true,
          consentGivenAt: new Date(),
        };
      }
      await db.sequelize.transaction(async (transaction) => {
        if (createdUser) {
          const user = await db.User.create(createdUser, { transaction });
          existingMember.userId = user.id;
          existingMember.User = user;
        }
        await existingMember.update({
          userId: existingMember.userId || null,
          memberNumber: data.memberNumber || existingMember.memberNumber,
          type: 'EMPLOYEE',
          nationalId: data.nationalId || existingMember.nationalId,
          status,
          dateJoined: data.joinDate ? new Date(data.joinDate) : existingMember.dateJoined,
          importProfile: mergeImportProfile(existingMember, data, status),
        }, { transaction });
        if (existingMember.User) {
          await existingMember.User.update({
            name: data.fullName || existingMember.User.name,
            ...(data.email ? { email: data.email } : {}),
            ...(data.phone ? { phone: data.phone } : {}),
            nationalId: data.nationalId || existingMember.User.nationalId,
            employerContribution: data.employerContribution,
            staffId: data.staffId || existingMember.User.staffId,
            payrollNumber: data.staffId || existingMember.User.payrollNumber,
            employmentTag: EMPLOYEE_TAG,
          }, { transaction });
        }
        await syncImportedMembershipFee({ member: existingMember, data, rowNumber: row.rowNumber, transaction });
        await syncImportedMemberBalances({ member: existingMember, data, rowNumber: row.rowNumber, transaction });
        await syncImportedLoanLiability({ member: existingMember, data, rowNumber: row.rowNumber, transaction });
      });
      imported.push({
        rowNumber: row.rowNumber,
        userId: existingMember.userId || null,
        memberId: existingMember.id,
        memberNumber: existingMember.memberNumber,
        status,
        accountCreated: Boolean(existingMember.userId),
        accountCreatedNow: Boolean(createdUser),
        updated: true,
      });
      continue;
    }

    const status = normalizeMemberStatus(data.status);
    const createsAccount = shouldCreateMemberAccount(status);
    if (!createsAccount) {
      const member = await db.sequelize.transaction(async (transaction) => {
        const archivedMember = await db.Member.create({
          memberNumber: data.memberNumber || `EXITED-${Date.now()}-${row.rowNumber}`,
          type: 'EMPLOYEE',
          nationalId: data.nationalId,
          shareCapital: data.shareCapital,
          savings: data.savings,
          employerContribution: data.employerContribution,
          status,
          isVerified: false,
          dateJoined: data.joinDate ? new Date(data.joinDate) : new Date(),
          importProfile: mergeImportProfile(null, data, status),
        }, { transaction });
        await syncImportedMembershipFee({ member: archivedMember, data, rowNumber: row.rowNumber, transaction });
        await syncImportedMemberBalances({ member: archivedMember, data, rowNumber: row.rowNumber, transaction });
        await syncImportedLoanLiability({ member: archivedMember, data, rowNumber: row.rowNumber, transaction });
        return archivedMember;
      });
      imported.push({
        rowNumber: row.rowNumber,
        memberId: member.id,
        memberNumber: member.memberNumber,
        status,
        accountCreated: false,
      });
      continue;
    }

    const existingUser = await db.User.findOne({
      where: {
        [Op.or]: [
          ...(data.email ? [{ email: data.email }] : []),
          { nationalId: data.nationalId },
          ...(data.phone ? [{ phone: data.phone }] : []),
        ],
      },
    });
    if (existingUser) {
      skipped.push({ rowNumber: row.rowNumber, email: data.email, reason: 'Email, National ID or phone already exists' });
      continue;
    }
    const password = '12345678';
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.sequelize.transaction(async (transaction) => {
      const user = await db.User.create({
        name: data.fullName,
        ...optionalStringField('email', data.email),
        ...optionalStringField('phone', data.phone),
        nationalId: data.nationalId,
        password: hashedPassword,
        role: 'EMPLOYEE',
        isVerified: true,
        employer: 'Ayedos',
        staffId: data.staffId || null,
        payrollNumber: data.staffId || null,
        employmentTag: EMPLOYEE_TAG,
        employerContribution: data.employerContribution,
        mustChangePassword: true,
        isWhitelisted: true,
        consentGiven: true,
        consentGivenAt: new Date(),
      }, { transaction });
      const member = await db.Member.create({
        userId: user.id,
        memberNumber: data.memberNumber || `AYEDOS-${Date.now()}-${String(user.id).slice(0, 6).toUpperCase()}`,
        type: 'EMPLOYEE',
        nationalId: data.nationalId,
        shareCapital: data.shareCapital,
        savings: data.savings,
        employerContribution: data.employerContribution,
        status,
        isVerified: true,
        dateJoined: data.joinDate ? new Date(data.joinDate) : new Date(),
        importProfile: {
          source: 'bulk_member_import',
          statementSheet: data.statementSheet || null,
          statementDetails: data.statementDetails || null,
          raw: data.raw || {},
        },
      }, { transaction });
      await member.update({ importProfile: mergeImportProfile(member, data, status) }, { transaction });
      await syncImportedMembershipFee({ member, data, rowNumber: row.rowNumber, transaction });
      await syncImportedMemberBalances({ member, data, rowNumber: row.rowNumber, transaction });
      await syncImportedLoanLiability({ member, data, rowNumber: row.rowNumber, transaction });
      return { user, member };
    });
    imported.push({
      rowNumber: row.rowNumber,
      userId: result.user.id,
      memberId: result.member.id,
      memberNumber: result.member.memberNumber,
      email: data.email,
      status,
      accountCreated: true,
    });
    } catch (error) {
      skipped.push({
        rowNumber: row.rowNumber,
        memberNumber: row.data?.memberNumber || null,
        nationalId: row.data?.nationalId || null,
        reason: error?.message || 'Failed to import row',
      });
      logger.error('Member import row failed', {
        module: 'admin',
        rowNumber: row.rowNumber,
        memberNumber: row.data?.memberNumber,
        nationalId: row.data?.nationalId,
        error: error?.message,
      });
    }
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

    const isStaffMember = true;
    const employerContribution = isStaffMember ? data.employerContribution : 0;
    await db.sequelize.transaction(async (transaction) => {
      await member.update({
        loans: data.loans,
        loanRepayment: data.loanRepayment,
        interest: data.interest,
        importProfile: {
          ...(member.importProfile || {}),
          lastFinancialImport: {
            sheetName: data.sheetName || null,
            loans: data.loans,
            loanRepayment: data.loanRepayment,
            interest: data.interest,
            importedAt: new Date().toISOString(),
          },
        },
      }, { transaction });
      if (member.User) {
        await member.User.update({
          employerContribution,
          staffId: isStaffMember ? (data.staffId || member.User.staffId) : null,
          payrollNumber: isStaffMember ? (data.staffId || member.User.payrollNumber) : null,
          employmentTag: EMPLOYEE_TAG,
        }, { transaction });
      }
      await syncImportedMemberBalances({
        member,
        data: { ...data, employerContribution },
        rowNumber: row.rowNumber,
        transaction,
      });
      await syncImportedLoanLiability({ member, data, rowNumber: row.rowNumber, transaction });
    });
    imported.push({ rowNumber: row.rowNumber, sheetName: data.sheetName, memberId: member.id, memberNumber: member.memberNumber });
  }
  return ResponseHandler.success(res, { imported, skipped, dividends: dividendResult }, 'Financial records imported successfully', 201);
});

module.exports = {
  getAllUsers,
  getArchivedMembers,
  getAuditLogs,
  getBlockedIdentityAttempts,
  unblockIdentityAttempt,
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
