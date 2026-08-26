const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const IdentityVerificationAttempt = sequelize.define('IdentityVerificationAttempt', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  documentType: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  documentNumber: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  firstName: DataTypes.STRING,
  surname: DataTypes.STRING,
  attemptCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  status: {
    type: DataTypes.ENUM('FAILED', 'BLOCKED', 'RESET', 'VERIFIED'),
    allowNull: false,
    defaultValue: 'FAILED',
  },
  blockStatus: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  reason: DataTypes.TEXT,
  failureReason: DataTypes.TEXT,
  ipAddress: DataTypes.STRING,
  blockedAt: DataTypes.DATE,
  resetAt: DataTypes.DATE,
  resetById: DataTypes.UUID,
}, {
  timestamps: true,
  indexes: [
    { fields: ['email'] },
    { fields: ['documentNumber'] },
    { fields: ['status'] },
    { fields: ['blockStatus'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = IdentityVerificationAttempt;
