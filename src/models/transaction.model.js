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
  reference: DataTypes.STRING,
  description: DataTypes.STRING,
  paymentCategory: DataTypes.STRING,
  kcbEndpoint: DataTypes.STRING,
  internalReference: DataTypes.STRING,
  checkoutRequestId: DataTypes.STRING,
  merchantRequestId: DataTypes.STRING,
  providerTransactionId: DataTypes.STRING,
  providerInternalReference: DataTypes.STRING,
  promptChannel: DataTypes.STRING
}, {
  timestamps: true,
  indexes: [
    { fields: ['reference'] },
    { fields: ['memberId'] },
    { fields: ['loanId'] },
    { fields: ['status'] },
    { fields: ['paymentCategory'] },
    { fields: ['internalReference'] },
    { fields: ['checkoutRequestId'] },
    { fields: ['providerTransactionId'] },
  ],
});

module.exports = Transaction;
