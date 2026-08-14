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
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'DISBURSED', 'COMPLETED', 'CANCELLED'),
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
  transfereeInfo: DataTypes.TEXT,
  reason: DataTypes.TEXT,
  uploadedFormName: DataTypes.STRING,
  uploadedFormDataUrl: DataTypes.TEXT,
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
  notes: DataTypes.TEXT,
  adminApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  financeApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  adminApprovedAt: DataTypes.DATE,
  financeApprovedAt: DataTypes.DATE,
  adminReviewedById: DataTypes.UUID,
  financeReviewedById: DataTypes.UUID,
  rejectionReason: DataTypes.TEXT,
  disbursedAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  disbursedAt: DataTypes.DATE,
  disbursedById: DataTypes.UUID,
  disbursementTransactionId: DataTypes.UUID,
  accessRevokedAt: DataTypes.DATE,
  metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} }
}, {
  timestamps: true,
  indexes: [
    { fields: ['memberId'] },
    { fields: ['status'] },
    { fields: ['requestedAt'] },
  ],
});

module.exports = MemberExitRequest;
