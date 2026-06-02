const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const LoginAttempt = sequelize.define('LoginAttempt', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  ip: DataTypes.STRING,
  userAgent: DataTypes.TEXT,
  status: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  requestId: DataTypes.STRING,
}, {
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['email', 'createdAt'] },
    { fields: ['ip', 'createdAt'] },
    { fields: ['status', 'createdAt'] },
  ],
});

module.exports = LoginAttempt;
