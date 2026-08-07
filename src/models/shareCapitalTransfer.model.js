const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const ShareCapitalTransfer = sequelize.define('ShareCapitalTransfer', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  senderMemberId: { type: DataTypes.UUID, allowNull: false },
  recipientMemberId: { type: DataTypes.UUID, allowNull: false },
  grossAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  feeAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  netAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  transferType: { type: DataTypes.ENUM('STANDARD', 'OPT_OUT'), allowNull: false },
  status: { type: DataTypes.ENUM('SUCCESS', 'FAILED'), allowNull: false, defaultValue: 'SUCCESS' },
  reference: { type: DataTypes.STRING, allowNull: false, unique: true },
  metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
}, { timestamps: true, indexes: [{ fields: ['senderMemberId'] }, { fields: ['recipientMemberId'] }, { fields: ['createdAt'] }] });

module.exports = ShareCapitalTransfer;
