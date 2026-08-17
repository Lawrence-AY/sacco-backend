const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const GroupLoan = sequelize.define('GroupLoan', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  groupId: { type: DataTypes.UUID, allowNull: false },
  proposalId: { type: DataTypes.UUID, allowNull: true, unique: true },
  requestedByMemberId: { type: DataTypes.UUID, allowNull: false },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  interestRate: { type: DataTypes.DECIMAL(6, 3), allowNull: false, defaultValue: 1 },
  paymentPeriodMonths: { type: DataTypes.INTEGER, allowNull: false },
  totalDue: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  balance: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  status: { type: DataTypes.ENUM('ACTIVE', 'REPAID'), allowNull: false, defaultValue: 'ACTIVE' },
}, { timestamps: true, indexes: [{ fields: ['groupId', 'status'] }] });

module.exports = GroupLoan;
