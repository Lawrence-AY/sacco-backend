const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const MemberDividend = sequelize.define('MemberDividend', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    field: 'user_id',
  },
  financialYearId: {
    type: DataTypes.UUID,
    allowNull: false,
    field: 'financial_year_id',
  },
  totalShares: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'total_shares',
  },
  dividendPaid: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'dividend_paid',
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
}, {
  timestamps: true,
  indexes: [
    { fields: ['user_id', 'financial_year_id'], unique: true },
    { fields: ['financial_year_id'] },
  ],
});

module.exports = MemberDividend;
