const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const GroupLoanAllocation = sequelize.define('GroupLoanAllocation', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  proposalId: { type: DataTypes.UUID, allowNull: false },
  memberId: { type: DataTypes.UUID, allowNull: false },
  allocatedPercentage: { type: DataTypes.DECIMAL(7, 4), allowNull: false },
  principalAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  interestAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  repaymentStatus: { type: DataTypes.ENUM('NOT_STARTED', 'ACTIVE', 'PAID', 'DEFAULTED'), allowNull: false, defaultValue: 'NOT_STARTED' },
  memberAcceptance: { type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'REJECTED'), allowNull: false, defaultValue: 'PENDING' },
  respondedAt: DataTypes.DATE,
}, { timestamps: true, indexes: [{ unique: true, fields: ['proposalId', 'memberId'] }, { fields: ['memberId', 'memberAcceptance'] }] });

module.exports = GroupLoanAllocation;
