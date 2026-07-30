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
