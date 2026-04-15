const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const Role = sequelize.define('Role', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.ENUM('ADMIN', 'FINANCE', 'MEMBER'),
    unique: true
  }
}, {
  timestamps: true
});

module.exports = Role;