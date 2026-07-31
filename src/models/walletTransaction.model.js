const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const WalletTransaction = sequelize.define('WalletTransaction', {
  id: {
    type: DataTypes.STRING(64),
    primaryKey: true,
    field: 'transaction_id',
  },
  transactionId: {
    type: DataTypes.STRING(64),
    unique: true,
  },
  walletId: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'wallet_id',
  },
  memberId: {
    type: DataTypes.STRING(32),
    allowNull: false,
    field: 'member_id',
  },
  type: {
    type: DataTypes.ENUM(
      'DEPOSIT',
      'WITHDRAWAL',
      'LOAN_DISBURSED',
      'LOAN_REPAYMENT',
      'SHARE_PURCHASE',
      'TRANSFER_INTERNAL',
      'DIVIDEND_PAYOUT',
      'MERCHANT_PAYMENT'
    ),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
  },
  currency: {
    type: DataTypes.STRING(3),
    defaultValue: 'KES',
    allowNull: false,
  },
  prevDepositedBalance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    field: 'prev_deposited_balance',
  },
  newDepositedBalance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    field: 'new_deposited_balance',
  },
  prevWithdrawableBalance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    field: 'prev_withdrawable_balance',
  },
  newWithdrawableBalance: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    field: 'new_withdrawable_balance',
  },
  paymentMethod: {
    type: DataTypes.ENUM('MPESA_STK', 'MPESA_B2C', 'BANK_TRANSFER', 'CASH_DESK'),
    allowNull: false,
    field: 'payment_method',
  },
  externalReference: {
    type: DataTypes.STRING(64),
    field: 'external_reference',
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'AI_ANALYZING', 'VERIFIED', 'REJECTED', 'FAILED'),
    defaultValue: 'PENDING',
    allowNull: false,
  },
  deviceId: { type: DataTypes.STRING(128), field: 'device_id' },
  ipAddress: { type: DataTypes.STRING(45), field: 'ip_address' },
  gpsLocation: { type: DataTypes.STRING(64), field: 'gps_location' },
  operatingSystem: { type: DataTypes.STRING(32), field: 'operating_system' },
  appVersion: { type: DataTypes.STRING(16), field: 'app_version' },
  riskScore: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'risk_score',
  },
  amlCheckPassed: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'aml_check_passed',
  },
  complianceStatus: {
    type: DataTypes.ENUM('PASSED', 'FLAGGED', 'UNDER_REVIEW'),
    defaultValue: 'PASSED',
    field: 'compliance_status',
  },
  complianceReason: {
    type: DataTypes.STRING,
    field: 'compliance_reason',
  },
}, {
  tableName: 'wallet_transactions',
  timestamps: true,
  indexes: [
    { fields: ['walletId'] },
    { fields: ['memberId'] },
    { fields: ['createdAt'] },
    { fields: ['status'] },
  ],
});

module.exports = WalletTransaction;
