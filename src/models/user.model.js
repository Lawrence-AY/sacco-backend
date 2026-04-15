const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: DataTypes.STRING,
  email: {
    type: DataTypes.STRING,
    unique: true
  },
  phone: DataTypes.STRING,
  password: DataTypes.STRING,
  role: {
    type: DataTypes.ENUM('ADMIN', 'FINANCE', 'MEMBER')
  },
  consentGiven: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  consentGivenAt: DataTypes.DATE
}, {
  timestamps: true
});

module.exports = User;