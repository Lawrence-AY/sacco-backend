const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const OtpSession = sequelize.define('OtpSession', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  loginSessionId: DataTypes.UUID,
  purpose: {
    type: DataTypes.ENUM('LOGIN', 'REGISTRATION'),
    allowNull: false,
  },
  otpHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  consumed: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  lastSentAt: DataTypes.DATE,
}, {
  timestamps: true,
  indexes: [
    { fields: ['userId', 'purpose', 'consumed'] },
    { fields: ['loginSessionId'] },
    { fields: ['expiresAt'] },
  ],
});

module.exports = OtpSession;
