const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const EmailJob = sequelize.define('EmailJob', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  queueName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  encryptedPayload: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED'),
    allowNull: false,
    defaultValue: 'PENDING',
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  provider: DataTypes.STRING,
  providerMessageId: DataTypes.STRING,
  lastError: DataTypes.TEXT,
  nextAttemptAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  sentAt: DataTypes.DATE,
}, {
  timestamps: true,
  indexes: [
    { fields: ['status', 'nextAttemptAt'] },
    { fields: ['queueName', 'createdAt'] },
  ],
});

module.exports = EmailJob;
