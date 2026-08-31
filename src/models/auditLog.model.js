const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const AuditLog = sequelize.define('AuditLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  module: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  method: DataTypes.STRING,
  route: DataTypes.STRING,
  statusCode: DataTypes.INTEGER,
  ip: DataTypes.STRING,
  userAgent: DataTypes.TEXT,
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
}, {
  timestamps: true,
  hooks: {
    beforeUpdate: () => { throw new Error('Audit logs are append-only and cannot be updated'); },
    beforeDestroy: () => { throw new Error('Audit logs are append-only and cannot be deleted'); },
    beforeBulkUpdate: () => { throw new Error('Audit logs are append-only and cannot be updated'); },
    beforeBulkDestroy: () => { throw new Error('Audit logs are append-only and cannot be deleted'); },
  },
  indexes: [
    { fields: ['userId'] },
    { fields: ['action'] },
    { fields: ['module'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = AuditLog;
