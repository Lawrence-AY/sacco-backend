const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const PasswordHistory = sequelize.define('PasswordHistory', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
}, {
  timestamps: true,
  updatedAt: false,
  indexes: [{ fields: ['userId', 'createdAt'] }],
});

module.exports = PasswordHistory;
