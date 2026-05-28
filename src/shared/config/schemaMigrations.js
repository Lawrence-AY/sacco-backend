const { DataTypes } = require('sequelize');
const logger = require('../utils/logger');

const userColumns = {
  dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
  gender: { type: DataTypes.STRING, allowNull: true },
  employer: { type: DataTypes.STRING, allowNull: true },
  monthlyIncome: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  payrollNumber: { type: DataTypes.STRING, allowNull: true },
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

const searchIndexes = [
  ['Members', ['memberNumber'], 'idx_members_member_number'],
  ['Members', ['nationalId'], 'idx_members_national_id'],
  ['Users', ['email'], 'idx_users_email'],
  ['Users', ['phone'], 'idx_users_phone'],
  ['Users', ['nationalId'], 'idx_users_national_id'],
  ['Users', ['lockedUntil'], 'idx_users_locked_until'],
  ['Transactions', ['reference'], 'idx_transactions_reference'],
  ['Transactions', ['memberId'], 'idx_transactions_member_id'],
  ['Transactions', ['paymentCategory'], 'idx_transactions_payment_category'],
  ['Transactions', ['internalReference'], 'idx_transactions_internal_reference'],
  ['Loans', ['memberId'], 'idx_loans_member_id'],
  ['Loans', ['status'], 'idx_loans_status'],
  ['MembershipApplications', ['email'], 'idx_applications_email'],
  ['MembershipApplications', ['phone'], 'idx_applications_phone'],
  ['MembershipApplications', ['nationalId'], 'idx_applications_national_id'],
  ['MembershipApplications', ['paymentReference'], 'idx_applications_payment_reference'],
];

const ensureSearchIndexes = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();

  for (const [tableName, fields, name] of searchIndexes) {
    const indexes = await queryInterface.showIndex(tableName).catch(() => []);
    const exists = indexes.some((index) => index.name === name);
    if (!exists) {
      await queryInterface.addIndex(tableName, fields, { name });
      logger.info('Added search index', { tableName, fields, name });
    }
  }
};

const runSchemaMigrations = async (sequelize) => {
  await ensureUserProfileColumns(sequelize);
  await ensureTransactionTrackingColumns(sequelize);
  await ensureSearchIndexes(sequelize);
};

module.exports = {
  runSchemaMigrations,
};
