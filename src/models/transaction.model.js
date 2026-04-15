const { DataTypes } = require('sequelize');
const sequelize = require('../shared/config/db');
const Member = require('./member.model');
const Loan = require('./loan.model');

const Transaction = sequelize.define('Transaction', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  memberId: DataTypes.UUID,
  loanId: DataTypes.UUID,
  type: {
    type: DataTypes.ENUM(
      'DEPOSIT',
      'WITHDRAWAL',
      'DIVIDEND',
      'LOAN_DISBURSEMENT',
      'LOAN_REPAYMENT',
      'MEMBERSHIP_FEE'
    )
  },
  amount: DataTypes.FLOAT,
  method: {
    type: DataTypes.ENUM('SALARY', 'MPESA', 'MANUAL')
  },
  status: {
    type: DataTypes.ENUM('PENDING', 'SUCCESS', 'FAILED')
  },
  reference: DataTypes.STRING
}, {
  timestamps: true
});

module.exports = Transaction;