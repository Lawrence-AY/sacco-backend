const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

module.exports = sequelize.define('SecretaryRecord', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  kind: { type: DataTypes.ENUM('MEETING', 'DOCUMENT'), allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'DRAFT' },
  payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  createdById: { type: DataTypes.UUID, allowNull: false },
}, { timestamps: true, indexes: [{ fields: ['kind'] }, { fields: ['createdById'] }] });
