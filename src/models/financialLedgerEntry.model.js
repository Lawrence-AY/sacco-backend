const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const FinancialLedgerEntry = sequelize.define('FinancialLedgerEntry', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  transactionId: { type: DataTypes.UUID, allowNull: false, field: 'transaction_id' },
  loanId: { type: DataTypes.UUID, allowNull: true, field: 'loan_id' },
  memberId: { type: DataTypes.UUID, allowNull: true, field: 'member_id' },
  account: {
    type: DataTypes.ENUM('CASH', 'LOAN_RECEIVABLE', 'INTEREST_INCOME'),
    allowNull: false,
  },
  side: {
    type: DataTypes.ENUM('DEBIT', 'CREDIT'),
    allowNull: false,
  },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'KES' },
  memo: { type: DataTypes.STRING },
  postedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'posted_at' },
}, {
  tableName: 'financial_ledger_entries',
  underscored: true,
  timestamps: true,
  indexes: [
    { fields: ['transactionId'] },
    { fields: ['loanId'] },
    { fields: ['memberId'] },
    { fields: ['account'] },
    { fields: ['postedAt'] },
  ],
});

module.exports = FinancialLedgerEntry;
