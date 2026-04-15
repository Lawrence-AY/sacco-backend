const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Member = require('./member.model');

const ShareAccount = sequelize.define('ShareAccount', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: {
    type: DataTypes.UUID,
    unique: true
  },
  shares: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  shareValue: {
    type: DataTypes.FLOAT,
    defaultValue: 100
  }
}, {
  timestamps: true
});

module.exports = ShareAccount;