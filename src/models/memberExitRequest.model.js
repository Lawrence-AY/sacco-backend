const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const MemberExitRequest = sequelize.define('MemberExitRequest', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'),
    defaultValue: 'PENDING'
  },
  savingsWithdrawalAmount: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  shareCapitalAmount: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  saccoFeeAmount: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  auctionAmount: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  buyerMemberNumber: DataTypes.STRING,
  reason: DataTypes.TEXT,
  acknowledgedTerms: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  requestedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  reviewedAt: DataTypes.DATE,
  reviewedById: DataTypes.UUID,
  notes: DataTypes.TEXT
}, {
  timestamps: true,
  indexes: [
    { fields: ['memberId'] },
    { fields: ['status'] },
    { fields: ['requestedAt'] },
  ],
});

module.exports = MemberExitRequest;
