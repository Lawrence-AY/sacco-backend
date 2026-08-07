const { DataTypes } = require('sequelize');
const logger = require('../utils/logger');

const userColumns = {
  dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
  gender: { type: DataTypes.STRING, allowNull: true },
  employer: { type: DataTypes.STRING, allowNull: true },
  monthlyIncome: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  payrollNumber: { type: DataTypes.STRING, allowNull: true },
  staffId: { type: DataTypes.STRING, allowNull: true },
  isWhitelisted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  employerContribution: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  nextOfKinName: { type: DataTypes.STRING, allowNull: true },
  nextOfKinRelationship: { type: DataTypes.STRING, allowNull: true },
  nextOfKinPhone: { type: DataTypes.STRING, allowNull: true },
  otpAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  otpLastSentAt: { type: DataTypes.DATE, allowNull: true },
  failedLoginAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  lockedUntil: { type: DataTypes.DATE, allowNull: true },
  lastLoginIp: { type: DataTypes.STRING, allowNull: true },
  lastLoginAt: { type: DataTypes.DATE, allowNull: true },
};

const ensureUserProfileColumns = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('Users');

  for (const [column, definition] of Object.entries(userColumns)) {
    if (!table[column]) {
      await queryInterface.addColumn('Users', column, definition);
      logger.info('Added missing Users profile column', { column });
    }
  }

  if (table.idDocumentUrl?.type && !String(table.idDocumentUrl.type).toUpperCase().includes('TEXT')) {
    await queryInterface.changeColumn('Users', 'idDocumentUrl', { type: DataTypes.TEXT, allowNull: true });
    logger.info('Expanded Users.idDocumentUrl to TEXT');
  }

  if (table.passportPhotoUrl?.type && !String(table.passportPhotoUrl.type).toUpperCase().includes('TEXT')) {
    await queryInterface.changeColumn('Users', 'passportPhotoUrl', { type: DataTypes.TEXT, allowNull: true });
    logger.info('Expanded Users.passportPhotoUrl to TEXT');
  }
};

const transactionTrackingColumns = {
  description: { type: DataTypes.STRING, allowNull: true },
  paymentCategory: { type: DataTypes.STRING, allowNull: true },
  kcbEndpoint: { type: DataTypes.STRING, allowNull: true },
  internalReference: { type: DataTypes.STRING, allowNull: true },
  promptChannel: { type: DataTypes.STRING, allowNull: true },
};

const ensureTransactionTrackingColumns = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('Transactions');

  for (const [column, definition] of Object.entries(transactionTrackingColumns)) {
    if (!table[column]) {
      await queryInterface.addColumn('Transactions', column, definition);
      logger.info('Added missing Transactions tracking column', { column });
    }
  }
};

const loginSessionColumns = {
  idempotencyKey: { type: DataTypes.STRING, allowNull: true },
  refreshTokenHash: { type: DataTypes.STRING(64), allowNull: true },
};

const ensureLoginSessionColumns = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('LoginSessions');

  for (const [column, definition] of Object.entries(loginSessionColumns)) {
    if (!table[column]) {
      await queryInterface.addColumn('LoginSessions', column, definition);
      logger.info('Added missing LoginSessions column', { column });
    }
  }
};

const searchIndexes = [
  ['Members', ['memberNumber'], 'idx_members_member_number'],
  ['Members', ['nationalId'], 'idx_members_national_id'],
  ['Users', ['email'], 'idx_users_email'],
  ['Users', ['phone'], 'idx_users_phone'],
  ['Users', ['nationalId'], 'idx_users_national_id'],
  ['Users', ['lockedUntil'], 'idx_users_locked_until'],
  ['Transactions', ['reference'], 'idx_transactions_reference'],
  ['Transactions', ['reference'], 'uniq_transactions_reference', true],
  ['Transactions', ['memberId'], 'idx_transactions_member_id'],
  ['Transactions', ['paymentCategory'], 'idx_transactions_payment_category'],
  ['Transactions', ['internalReference'], 'idx_transactions_internal_reference'],
  ['Transactions', ['internalReference'], 'uniq_transactions_internal_reference', true],
  ['Loans', ['memberId'], 'idx_loans_member_id'],
  ['Loans', ['status'], 'idx_loans_status'],
  ['MembershipApplications', ['email'], 'idx_applications_email'],
  ['MembershipApplications', ['phone'], 'idx_applications_phone'],
  ['MembershipApplications', ['nationalId'], 'idx_applications_national_id'],
  ['MembershipApplications', ['paymentReference'], 'idx_applications_payment_reference'],
  ['LoginSessions', ['idempotencyKey'], 'uniq_login_sessions_idempotency_key', true],
];

const ensureSearchIndexes = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();

  for (const [tableName, fields, name, unique = false] of searchIndexes) {
    const indexes = await queryInterface.showIndex(tableName).catch(() => []);
    const exists = indexes.some((index) => index.name === name);
    if (!exists) {
      try {
        await queryInterface.addIndex(tableName, fields, { name, unique });
        logger.info('Added search index', { tableName, fields, name, unique });
      } catch (error) {
        logger.warn('Unable to add search index', {
          tableName,
          fields,
          name,
          unique,
          error: error.message,
        });
      }
    }
  }
};

const ensureNotificationTable = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const exists = tables.some((table) => String(typeof table === 'object' ? table.tableName || table.name : table) === 'Notifications');

  if (!exists) {
    await queryInterface.createTable('Notifications', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      eventKey: { type: DataTypes.STRING, allowNull: false, unique: true },
      title: { type: DataTypes.STRING, allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      category: { type: DataTypes.STRING, allowNull: false, defaultValue: 'account' },
      severity: { type: DataTypes.STRING, allowNull: false, defaultValue: 'info' },
      actionUrl: { type: DataTypes.STRING, allowNull: true },
      sourceType: { type: DataTypes.STRING, allowNull: true },
      sourceId: { type: DataTypes.UUID, allowNull: true },
      readAt: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    });
    logger.info('Created Notifications table');
  }
};

const ensureMemberExitRequestTable = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const exists = tables.some((table) => String(typeof table === 'object' ? table.tableName || table.name : table) === 'MemberExitRequests');

  if (!exists) {
    await queryInterface.createTable('MemberExitRequests', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      status: {
        type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'),
        allowNull: false,
        defaultValue: 'PENDING'
      },
      savingsWithdrawalAmount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      shareCapitalAmount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      saccoFeeAmount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      auctionAmount: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      buyerMemberNumber: { type: DataTypes.STRING, allowNull: true },
      reason: { type: DataTypes.TEXT, allowNull: true },
      acknowledgedTerms: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      requestedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      reviewedAt: { type: DataTypes.DATE, allowNull: true },
      reviewedById: { type: DataTypes.UUID, allowNull: true },
      notes: { type: DataTypes.TEXT, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    });
    logger.info('Created MemberExitRequests table');
  }
};

const ensureShareCapitalFeatures = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const memberTable = await queryInterface.describeTable('Members');
  if (!memberTable.nominees) {
    await queryInterface.addColumn('Members', 'nominees', { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
  }
  const tables = await queryInterface.showAllTables();
  const names = tables.map((table) => String(typeof table === 'object' ? table.tableName || table.name : table));
  if (!names.includes('ShareCapitalTransfers')) {
    await queryInterface.createTable('ShareCapitalTransfers', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      senderMemberId: { type: DataTypes.UUID, allowNull: false },
      recipientMemberId: { type: DataTypes.UUID, allowNull: false },
      grossAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      feeAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      netAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      transferType: { type: DataTypes.ENUM('STANDARD', 'OPT_OUT'), allowNull: false },
      status: { type: DataTypes.ENUM('SUCCESS', 'FAILED'), allowNull: false, defaultValue: 'SUCCESS' },
      reference: { type: DataTypes.STRING, allowNull: false, unique: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    });
  }
};

const ensureBorrowingGroupTables = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const tables = await queryInterface.showAllTables();
  const names = new Set(tables.map((table) => String(typeof table === 'object' ? table.tableName || table.name : table)));
  if (!names.has('BorrowingGroups')) await queryInterface.createTable('BorrowingGroups', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true }, name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.STRING(500), allowNull: true }, creatorMemberId: { type: DataTypes.UUID, allowNull: false },
    status: { type: DataTypes.ENUM('ACTIVE', 'CLOSED'), allowNull: false, defaultValue: 'ACTIVE' },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  if (!names.has('GroupMemberships')) await queryInterface.createTable('GroupMemberships', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true }, groupId: { type: DataTypes.UUID, allowNull: false }, memberId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.ENUM('CREATOR', 'MEMBER'), allowNull: false, defaultValue: 'MEMBER' }, status: { type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'LEFT', 'REMOVED'), allowNull: false, defaultValue: 'PENDING' },
    invitedByMemberId: { type: DataTypes.UUID, allowNull: false }, respondedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  if (!names.has('GroupLoans')) await queryInterface.createTable('GroupLoans', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true }, groupId: { type: DataTypes.UUID, allowNull: false }, requestedByMemberId: { type: DataTypes.UUID, allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, interestRate: { type: DataTypes.DECIMAL(6, 3), allowNull: false, defaultValue: 1 }, paymentPeriodMonths: { type: DataTypes.INTEGER, allowNull: false },
    totalDue: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, balance: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, status: { type: DataTypes.ENUM('ACTIVE', 'REPAID'), allowNull: false, defaultValue: 'ACTIVE' },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  if (!names.has('GroupTransactions')) await queryInterface.createTable('GroupTransactions', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true }, groupId: { type: DataTypes.UUID, allowNull: false }, loanId: { type: DataTypes.UUID, allowNull: true }, memberId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.ENUM('LOAN_DISBURSEMENT', 'LOAN_REPAYMENT'), allowNull: false }, amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, reference: { type: DataTypes.STRING, allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('SUCCESS'), allowNull: false, defaultValue: 'SUCCESS' }, createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }, updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
  const groupIndexes = [
    ['GroupMemberships', ['groupId', 'memberId'], 'uniq_group_membership', true],
    ['GroupMemberships', ['memberId', 'status'], 'idx_group_membership_status', false],
    ['BorrowingGroups', ['creatorMemberId'], 'idx_borrowing_group_creator', false],
    ['GroupLoans', ['groupId', 'status'], 'idx_group_loan_status', false],
    ['GroupTransactions', ['groupId', 'createdAt'], 'idx_group_transaction_history', false],
  ];
  for (const [table, fields, name, unique] of groupIndexes) {
    const indexes = await queryInterface.showIndex(table).catch(() => []);
    if (!indexes.some((index) => index.name === name)) await queryInterface.addIndex(table, fields, { name, unique }).catch((error) => logger.warn('Unable to add group index', { name, error: error.message }));
  }
};

const runSchemaMigrations = async (sequelize) => {
  await ensureNotificationTable(sequelize);
  await ensureMemberExitRequestTable(sequelize);
  await ensureShareCapitalFeatures(sequelize);
  await ensureBorrowingGroupTables(sequelize);
  await ensureUserProfileColumns(sequelize);
  await ensureTransactionTrackingColumns(sequelize);
  await ensureTableColumns(sequelize, 'Members', memberDocumentColumns);
  await ensureTableColumns(sequelize, 'MembershipApplications', applicationDocumentColumns);
  await ensureTableColumns(sequelize, 'Guarantors', guarantorWorkflowColumns);
  await ensureLoginSessionColumns(sequelize);
  await ensureSearchIndexes(sequelize);
};

module.exports = {
  runSchemaMigrations,
};
