const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Member = require('./member.model');

const SavingsAccount = sequelize.define('SavingsAccount', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: {
    type: DataTypes.UUID,
    unique: true
  },
  balance: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  }
}, {
  timestamps: true
});

module.exports = SavingsAccount;