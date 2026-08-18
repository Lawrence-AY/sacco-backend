const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const FinancialYearReport = sequelize.define('FinancialYearReport', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  year: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  category: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
    defaultValue: 0,
  },
  percentageUsed: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'percentage_used',
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
}, {
  timestamps: true,
  indexes: [
    { fields: ['year', 'category'], unique: true },
    { fields: ['year'] },
  ],
});

module.exports = FinancialYearReport;
