const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Member = require('./member.model');

const Dividend = sequelize.define('Dividend', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: DataTypes.UUID,
  year: DataTypes.INTEGER,
  amount: DataTypes.FLOAT
}, {
  timestamps: true
});

module.exports = Dividend;