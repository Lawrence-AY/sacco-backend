const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const GroupLoanProposal = sequelize.define('GroupLoanProposal', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  groupId: { type: DataTypes.UUID, allowNull: false },
  createdBy: { type: DataTypes.UUID, allowNull: false },
  totalAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  durationMonths: { type: DataTypes.INTEGER, allowNull: false },
  interestRate: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
  status: { type: DataTypes.ENUM('DRAFT', 'PENDING_MEMBER_APPROVAL', 'APPROVED', 'REJECTED', 'DISBURSED'), allowNull: false, defaultValue: 'DRAFT' },
  approvedAt: DataTypes.DATE,
  disbursedAt: DataTypes.DATE,
}, { timestamps: true, indexes: [{ fields: ['groupId', 'status'] }, { fields: ['createdBy'] }] });

module.exports = GroupLoanProposal;
