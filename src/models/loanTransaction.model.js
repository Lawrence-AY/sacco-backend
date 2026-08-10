const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const LoanTransaction = sequelize.define('LoanTransaction', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  loanId: { type: DataTypes.UUID, allowNull: false }, memberId: { type: DataTypes.UUID, allowNull: false },
  ledgerTransactionId: { type: DataTypes.UUID, allowNull: false },
  transactionType: { type: DataTypes.ENUM('INTERIM_PAYMENT', 'SCHEDULED_PAYMENT'), allowNull: false, defaultValue: 'INTERIM_PAYMENT' },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, principalPaid: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  interestPaid: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, remainingPrincipal: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  accruedDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
}, { timestamps: true, indexes: [{ fields: ['loanId', 'createdAt'] }, { fields: ['memberId'] }, { fields: ['ledgerTransactionId'], unique: true }] });
module.exports = LoanTransaction;
