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
  multiplier: DataTypes.FLOAT,
  status: {
    type: DataTypes.ENUM(
      'PENDING',
      'APPROVED',
      'REJECTED',
      'ACTIVE',
      'COMPLETED'
    ),
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
  timestamps: true
});

module.exports = Loan;