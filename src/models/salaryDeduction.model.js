const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Member = require('./member.model');

const SalaryDeduction = sequelize.define('SalaryDeduction', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: DataTypes.UUID,
  shareAmount: DataTypes.FLOAT,
  contribution: DataTypes.FLOAT,
  startDate: DataTypes.DATE,
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  timestamps: true
});

module.exports = SalaryDeduction;