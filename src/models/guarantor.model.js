const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Loan = require('./loan.model');
const Member = require('./member.model');

const Guarantor = sequelize.define('Guarantor', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  loanId: DataTypes.UUID,
  memberId: DataTypes.UUID,
  amount: DataTypes.FLOAT
}, {
  timestamps: true
});

module.exports = Guarantor;