const sequelize = require('../shared/config/db');

const User = require('./user.model');
const Member = require('./member.model');
const Role = require('./role.model');
const SavingsAccount = require('./savingsAccount.model');
const ShareAccount = require('./shareAccount.model');
const Transaction = require('./transaction.model');
const Loan = require('./loan.model');
const Guarantor = require('./guarantor.model');
const Dividend = require('./dividend.model');
const SystemConfig = require('./systemConfig.model');
const MembershipApplication = require('./membershipApplication.model');
const SalaryDeduction = require('./salaryDeduction.model');

// Associations
User.hasOne(Member, { foreignKey: 'userId' });
Member.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(MembershipApplication, { foreignKey: 'approvedById', as: 'approvals' });
MembershipApplication.belongsTo(User, { foreignKey: 'approvedById', as: 'approvedBy' });

Member.hasOne(SavingsAccount, { foreignKey: 'memberId' });
SavingsAccount.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasOne(ShareAccount, { foreignKey: 'memberId' });
ShareAccount.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasMany(Transaction, { foreignKey: 'memberId' });
Transaction.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasMany(Loan, { foreignKey: 'memberId' });
Loan.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasMany(Dividend, { foreignKey: 'memberId' });
Dividend.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasMany(SalaryDeduction, { foreignKey: 'memberId' });
SalaryDeduction.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasMany(Guarantor, { foreignKey: 'memberId' });
Guarantor.belongsTo(Member, { foreignKey: 'memberId' });

Loan.hasMany(Transaction, { foreignKey: 'loanId' });
Transaction.belongsTo(Loan, { foreignKey: 'loanId' });

Loan.hasMany(Guarantor, { foreignKey: 'loanId' });
Guarantor.belongsTo(Loan, { foreignKey: 'loanId' });

const db = {
  sequelize,
  Sequelize: require('sequelize').Sequelize,
  User,
  Member,
  Role,
  SavingsAccount,
  ShareAccount,
  Transaction,
  Loan,
  Guarantor,
  Dividend,
  SystemConfig,
  MembershipApplication,
  SalaryDeduction
};

module.exports = db;