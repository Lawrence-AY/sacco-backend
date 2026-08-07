const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const User = require('./user.model');

const Member = sequelize.define('Member', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  userId: {
    type: DataTypes.UUID,
    unique: true
  },
  memberNumber: {
    type: DataTypes.STRING,
    unique: true
  },
  type: {
    type: DataTypes.ENUM('EMPLOYEE', 'NON_EMPLOYEE')
  },
  nationalId: DataTypes.STRING,
  nationalIdUrl: DataTypes.TEXT,
  passportUrl: DataTypes.TEXT,
  shareCapital: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  savings: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  loans: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  loanRepayment: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  interest: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  employerContribution: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'ACTIVE'
  },
  dateJoined: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  applicationId: DataTypes.UUID,
  paymentReference: DataTypes.STRING,
  registrationTransactionId: DataTypes.UUID,
  isVerified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  nominees: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: []
  }
}, {
  timestamps: true,
  indexes: [
    { fields: ['memberNumber'] },
    { fields: ['nationalId'] },
    { fields: ['userId'] },
  ],
});

module.exports = Member;
