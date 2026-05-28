// src/models/user.model.js
const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  firstName: DataTypes.STRING,
  lastName: DataTypes.STRING,
  name: DataTypes.STRING,
  email: {
    type: DataTypes.STRING,
    unique: true
  },
  phone: DataTypes.STRING,
  password: DataTypes.STRING,
  nationalId: DataTypes.STRING,
  kraPin: DataTypes.STRING,
  occupation: DataTypes.STRING,
  address: DataTypes.TEXT,
  dateOfBirth: DataTypes.DATEONLY,
  gender: DataTypes.STRING,
  employer: DataTypes.STRING,
  monthlyIncome: DataTypes.DECIMAL(14, 2),
  payrollNumber: DataTypes.STRING,
  nextOfKinName: DataTypes.STRING,
  nextOfKinRelationship: DataTypes.STRING,
  nextOfKinPhone: DataTypes.STRING,
  idDocumentUrl: DataTypes.TEXT,
  passportPhotoUrl: DataTypes.TEXT,
  role: {
    type: DataTypes.ENUM('PENDING', 'MEMBER', 'FINANCE', 'ADMIN', 'SUPERADMIN'),
    defaultValue: 'PENDING'
  },
  isVerified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  otp: DataTypes.STRING(8),
  otpExpiresAt: DataTypes.DATE,
  otpAttempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  otpLastSentAt: DataTypes.DATE,
  failedLoginAttempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  lockedUntil: DataTypes.DATE,
  lastLoginIp: DataTypes.STRING,
  lastLoginAt: DataTypes.DATE,
  passwordResetToken: {
    type: DataTypes.STRING,
    allowNull: true
  },
  passwordResetExpires: {
    type: DataTypes.DATE,
    allowNull: true
  },
  consentGiven: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  consentGivenAt: DataTypes.DATE
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['email']
    },
    {
      fields: ['phone']
    },
    {
      fields: ['nationalId']
    },
    {
      fields: ['passwordResetToken']
    }
  ]
});

module.exports = User;
