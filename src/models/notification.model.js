const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const Notification = sequelize.define('Notification', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  eventKey: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  category: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'account',
  },
  severity: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'info',
  },
  actionUrl: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  sourceType: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  sourceId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  readAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
}, {
  timestamps: true,
  indexes: [
    { fields: ['userId'] },
    { fields: ['eventKey'], unique: true },
    { fields: ['readAt'] },
    { fields: ['category'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = Notification;
