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
  idDocumentUrl: DataTypes.STRING,
  passportPhotoUrl: DataTypes.STRING,
  role: {
    type: DataTypes.ENUM('PENDING', 'ADMIN', 'FINANCE', 'MEMBER'),
    defaultValue: 'PENDING'
  },
  isVerified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  otp: DataTypes.STRING(8),
  otpExpiresAt: DataTypes.DATE,
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
      fields: ['passwordResetToken']
    }
  ]
});

module.exports = User;
