const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const User = require('./user.model');

const MembershipApplication = sequelize.define('MembershipApplication', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: DataTypes.STRING,
  nationalId: DataTypes.STRING,
  kraPin: DataTypes.STRING,
  phone: DataTypes.STRING,
  email: DataTypes.STRING,
  type: {
    type: DataTypes.ENUM('EMPLOYEE', 'NON_EMPLOYEE')
  },
  status: {
    type: DataTypes.ENUM('PENDING_PAYMENT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'),
    defaultValue: 'PENDING_PAYMENT'
  },
  feePaid: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  paymentVerifiedAt: DataTypes.DATE,
  paymentReference: DataTypes.STRING,
  paymentPhone: DataTypes.STRING,
  paymentConfirmedAt: DataTypes.DATE,
  activationToken: DataTypes.STRING,
  activationTokenExpiresAt: DataTypes.DATE,
  consentGiven: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  consentGivenAt: DataTypes.DATE,
  approvedById: DataTypes.UUID,
  rejectedReason: DataTypes.STRING
}, {
  timestamps: true
});

module.exports = MembershipApplication;
