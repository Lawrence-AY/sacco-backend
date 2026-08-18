const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const BorrowingGroup = sequelize.define('BorrowingGroup', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  description: { type: DataTypes.STRING(500), allowNull: true },
  creatorMemberId: { type: DataTypes.UUID, allowNull: false },
  status: { type: DataTypes.ENUM('ACTIVE', 'CLOSED'), allowNull: false, defaultValue: 'ACTIVE' },
  governanceSettings: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
}, { timestamps: true, indexes: [{ fields: ['creatorMemberId'] }, { fields: ['status'] }] });

module.exports = BorrowingGroup;
