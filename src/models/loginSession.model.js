const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const LoginSession = sequelize.define('LoginSession', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  deviceId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  deviceName: DataTypes.STRING,
  userAgent: DataTypes.TEXT,
  ipAddress: DataTypes.STRING,
  location: DataTypes.STRING,
  status: {
    type: DataTypes.ENUM('OTP_SENT', 'ACTIVE', 'LOGGED_OUT', 'FAILED'),
    defaultValue: 'OTP_SENT'
  },
  isCurrentDevice: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  isNewDevice: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  loginAt: DataTypes.DATE,
  lastActiveAt: DataTypes.DATE,
  logoutAt: DataTypes.DATE,
  event: {
    type: DataTypes.STRING,
    defaultValue: 'Login verification'
  }
}, {
  timestamps: true,
  indexes: [
    { fields: ['userId'] },
    { fields: ['deviceId'] },
    { fields: ['status'] }
  ]
});

module.exports = LoginSession;
