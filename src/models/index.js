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
const LoginSession = require('./loginSession.model');
const AuditLog = require('./auditLog.model');
const Notification = require('./notification.model');
const OtpSession = require('./otpSession.model');
const LoginAttempt = require('./loginAttempt.model');
const EmailJob = require('./emailJob.model');
const PasswordHistory = require('./passwordHistory.model');
const MemberExitRequest = require('./memberExitRequest.model');
const ShareCapitalListing = require('./shareCapitalListing.model');
const Bid = require('./bid.model');
const Wallet = require('./wallet.model');
const WalletTransaction = require('./walletTransaction.model');
const BlockchainBlock = require('./blockchainBlock.model');
const ShareCapitalTransfer = require('./shareCapitalTransfer.model');
const BorrowingGroup = require('./borrowingGroup.model');
const GroupMembership = require('./groupMembership.model');
const GroupLoan = require('./groupLoan.model');
const GroupLoanProposal = require('./groupLoanProposal.model');
const GroupLoanAllocation = require('./groupLoanAllocation.model');
const GroupGovernanceAction = require('./groupGovernanceAction.model');
const GroupTransaction = require('./groupTransaction.model');
const LoanTransaction = require('./loanTransaction.model');
const FinancialLedgerEntry = require('./financialLedgerEntry.model');
const FinancialYearReport = require('./financialYearReport.model');
const MemberDividend = require('./memberDividend.model');

const sequelize = require('../shared/config/db');

// Associations
User.hasOne(Member, { foreignKey: 'userId' });
Member.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(MembershipApplication, { foreignKey: 'approvedById', as: 'approvals' });
MembershipApplication.belongsTo(User, { foreignKey: 'approvedById', as: 'approvedBy' });

User.hasMany(LoginSession, { foreignKey: 'userId' });
LoginSession.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Notification, { foreignKey: 'userId' });
Notification.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(OtpSession, { foreignKey: 'userId' });
OtpSession.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(PasswordHistory, { foreignKey: 'userId' });
PasswordHistory.belongsTo(User, { foreignKey: 'userId' });

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

Member.hasMany(MemberExitRequest, { foreignKey: 'memberId' });
MemberExitRequest.belongsTo(Member, { foreignKey: 'memberId' });

Member.hasMany(ShareCapitalListing, { foreignKey: 'memberId' });
ShareCapitalListing.belongsTo(Member, { foreignKey: 'memberId' });

ShareCapitalListing.hasMany(Bid, { foreignKey: 'listingId' });
Bid.belongsTo(ShareCapitalListing, { foreignKey: 'listingId' });

Member.hasMany(Bid, { foreignKey: 'bidderId' });
Bid.belongsTo(Member, { foreignKey: 'bidderId' });

Wallet.hasMany(WalletTransaction, { foreignKey: 'walletId' });
WalletTransaction.belongsTo(Wallet, { foreignKey: 'walletId' });

WalletTransaction.hasOne(BlockchainBlock, { foreignKey: 'transactionId' });
BlockchainBlock.belongsTo(WalletTransaction, { foreignKey: 'transactionId' });

Loan.hasMany(Transaction, { foreignKey: 'loanId' });
Transaction.belongsTo(Loan, { foreignKey: 'loanId' });

Loan.hasMany(Guarantor, { foreignKey: 'loanId' });
Guarantor.belongsTo(Loan, { foreignKey: 'loanId' });

Member.hasMany(ShareCapitalTransfer, { foreignKey: 'senderMemberId', as: 'sentShareCapitalTransfers' });
Member.hasMany(ShareCapitalTransfer, { foreignKey: 'recipientMemberId', as: 'receivedShareCapitalTransfers' });
ShareCapitalTransfer.belongsTo(Member, { foreignKey: 'senderMemberId', as: 'sender' });
ShareCapitalTransfer.belongsTo(Member, { foreignKey: 'recipientMemberId', as: 'recipient' });

Member.hasMany(BorrowingGroup, { foreignKey: 'creatorMemberId', as: 'createdBorrowingGroups' });
BorrowingGroup.belongsTo(Member, { foreignKey: 'creatorMemberId', as: 'creator' });
BorrowingGroup.hasMany(GroupMembership, { foreignKey: 'groupId', as: 'memberships' });
GroupMembership.belongsTo(BorrowingGroup, { foreignKey: 'groupId', as: 'group' });
Member.hasMany(GroupMembership, { foreignKey: 'memberId', as: 'groupMemberships' });
GroupMembership.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
BorrowingGroup.hasMany(GroupLoan, { foreignKey: 'groupId', as: 'loans' });
GroupLoan.belongsTo(BorrowingGroup, { foreignKey: 'groupId', as: 'group' });
BorrowingGroup.hasMany(GroupLoanProposal, { foreignKey: 'groupId', as: 'proposals' });
GroupLoanProposal.belongsTo(BorrowingGroup, { foreignKey: 'groupId', as: 'group' });
GroupLoanProposal.hasMany(GroupLoanAllocation, { foreignKey: 'proposalId', as: 'allocations' });
GroupLoanAllocation.belongsTo(GroupLoanProposal, { foreignKey: 'proposalId', as: 'proposal' });
Member.hasMany(GroupLoanAllocation, { foreignKey: 'memberId', as: 'groupLoanAllocations' });
GroupLoanAllocation.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });
BorrowingGroup.hasMany(GroupTransaction, { foreignKey: 'groupId', as: 'transactions' });
GroupTransaction.belongsTo(BorrowingGroup, { foreignKey: 'groupId', as: 'group' });
BorrowingGroup.hasMany(GroupGovernanceAction, { foreignKey: 'groupId', as: 'governanceActions' });
GroupGovernanceAction.belongsTo(BorrowingGroup, { foreignKey: 'groupId', as: 'group' });
Member.hasMany(GroupGovernanceAction, { foreignKey: 'proposedByMemberId', as: 'proposedGroupGovernanceActions' });
GroupGovernanceAction.belongsTo(Member, { foreignKey: 'proposedByMemberId', as: 'proposedBy' });
GroupLoan.hasMany(GroupTransaction, { foreignKey: 'loanId', as: 'transactions' });
GroupTransaction.belongsTo(GroupLoan, { foreignKey: 'loanId', as: 'loan' });
Loan.hasMany(LoanTransaction, { foreignKey: 'loanId', as: 'loanTransactions' });
LoanTransaction.belongsTo(Loan, { foreignKey: 'loanId' });
Member.hasMany(LoanTransaction, { foreignKey: 'memberId' });
LoanTransaction.belongsTo(Member, { foreignKey: 'memberId' });
Transaction.hasMany(FinancialLedgerEntry, { foreignKey: 'transactionId', as: 'ledgerEntries' });
FinancialLedgerEntry.belongsTo(Transaction, { foreignKey: 'transactionId' });
User.hasMany(MemberDividend, { foreignKey: 'userId' });
MemberDividend.belongsTo(User, { foreignKey: 'userId' });
FinancialYearReport.hasMany(MemberDividend, { foreignKey: 'financialYearId', as: 'memberDividends' });
MemberDividend.belongsTo(FinancialYearReport, { foreignKey: 'financialYearId', as: 'financialYear' });

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
  SalaryDeduction,
  LoginSession,
  AuditLog,
  Notification,
  OtpSession,
  LoginAttempt,
  EmailJob,
  PasswordHistory,
  MemberExitRequest,
  ShareCapitalListing,
  Bid,
  Wallet,
  WalletTransaction,
  BlockchainBlock,
  ShareCapitalTransfer,
  BorrowingGroup,
  GroupMembership,
  GroupLoan,
  GroupLoanProposal,
  GroupLoanAllocation,
  GroupGovernanceAction,
  GroupTransaction,
  LoanTransaction,
  FinancialLedgerEntry,
  FinancialYearReport,
  MemberDividend
};

module.exports = db;
