const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Member = require('./member.model');

const Loan = sequelize.define('Loan', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: DataTypes.UUID,
  amount: DataTypes.FLOAT,
  interestRate: DataTypes.FLOAT,
  duration: DataTypes.INTEGER,
  reason: DataTypes.TEXT,
  rejectionReason: DataTypes.TEXT,
  decidedAt: DataTypes.DATE,
  multiplier: DataTypes.FLOAT,
  selfGuaranteed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  selfGuaranteedAmount: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'PENDING'
  },
  type: {
    type: DataTypes.ENUM(
      'EMERGENCY',
      'EDUCATION',
      'WELFARE',
      'DEVELOPMENT'
    )
  },
  approvalStage: {
    type: DataTypes.ENUM(
      'INITIAL',
      'CREDIT_COMMITTEE',
      'MANAGEMENT',
      'HR',
      'FINANCE'
    ),
    defaultValue: 'INITIAL'
  },
  approvedById: DataTypes.UUID
}, {
  timestamps: true,
  indexes: [
    { fields: ['memberId'] },
    { fields: ['status'] },
    { fields: ['type'] },
  ],
});

module.exports = Loan;
