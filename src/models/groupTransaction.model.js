const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const GroupTransaction = sequelize.define('GroupTransaction', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  groupId: { type: DataTypes.UUID, allowNull: false },
  loanId: { type: DataTypes.UUID, allowNull: true },
  memberId: { type: DataTypes.UUID, allowNull: false },
  type: { type: DataTypes.ENUM('LOAN_DISBURSEMENT', 'LOAN_REPAYMENT'), allowNull: false },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  reference: { type: DataTypes.STRING, allowNull: false, unique: true },
  status: { type: DataTypes.ENUM('SUCCESS'), allowNull: false, defaultValue: 'SUCCESS' },
}, { timestamps: true, indexes: [{ fields: ['groupId', 'createdAt'] }, { fields: ['loanId'] }] });

module.exports = GroupTransaction;
