const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const GroupMembership = sequelize.define('GroupMembership', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  groupId: { type: DataTypes.UUID, allowNull: false },
  memberId: { type: DataTypes.UUID, allowNull: false },
  role: { type: DataTypes.ENUM('CREATOR', 'MEMBER'), allowNull: false, defaultValue: 'MEMBER' },
  status: { type: DataTypes.ENUM('INVITED', 'ACTIVE', 'REJECTED', 'LEFT', 'REMOVED'), allowNull: false, defaultValue: 'INVITED' },
  invitedByMemberId: { type: DataTypes.UUID, allowNull: false },
  respondedAt: { type: DataTypes.DATE, allowNull: true },
}, { timestamps: true, indexes: [{ unique: true, fields: ['groupId', 'memberId'] }, { fields: ['memberId', 'status'] }] });

module.exports = GroupMembership;
