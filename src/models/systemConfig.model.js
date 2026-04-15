const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const SystemConfig = sequelize.define('SystemConfig', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  shareCapital: {
    type: DataTypes.FLOAT,
    defaultValue: 20000
  },
  minMonthlySavings: {
    type: DataTypes.FLOAT,
    defaultValue: 1000
  }
}, {
  timestamps: true
});

module.exports = SystemConfig;