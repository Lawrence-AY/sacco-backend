const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const GroupGovernanceAction = sequelize.define('GroupGovernanceAction', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  groupId: { type: DataTypes.UUID, allowNull: false },
  proposedByMemberId: { type: DataTypes.UUID, allowNull: false },
  actionType: { type: DataTypes.STRING(80), allowNull: false },
  title: { type: DataTypes.STRING(160), allowNull: false },
  payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  votes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  status: { type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'), allowNull: false, defaultValue: 'PENDING' },
  executedAt: { type: DataTypes.DATE, allowNull: true },
}, { timestamps: true, indexes: [{ fields: ['groupId', 'status'] }, { fields: ['proposedByMemberId'] }] });

module.exports = GroupGovernanceAction;
