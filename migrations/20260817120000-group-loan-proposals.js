'use strict';
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    await queryInterface.changeColumn('GroupMemberships', 'status', { type: DataTypes.ENUM('INVITED', 'ACTIVE', 'REJECTED', 'LEFT', 'REMOVED'), allowNull: false, defaultValue: 'INVITED' });
    await queryInterface.addColumn('GroupLoans', 'proposalId', { type: DataTypes.UUID, allowNull: true, unique: true });
    await queryInterface.addColumn('Users', 'shareCapitalStatus', { type: DataTypes.ENUM('COMPLETED', 'INCOMPLETE'), allowNull: false, defaultValue: 'INCOMPLETE' });
    await queryInterface.createTable('GroupLoanProposals', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true }, groupId: { type: DataTypes.UUID, allowNull: false }, createdBy: { type: DataTypes.UUID, allowNull: false },
      totalAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, durationMonths: { type: DataTypes.INTEGER, allowNull: false }, interestRate: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
      status: { type: DataTypes.ENUM('DRAFT', 'PENDING_MEMBER_APPROVAL', 'APPROVED', 'REJECTED', 'DISBURSED'), allowNull: false, defaultValue: 'DRAFT' }, approvedAt: DataTypes.DATE, disbursedAt: DataTypes.DATE,
      createdAt: { type: DataTypes.DATE, allowNull: false }, updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.createTable('GroupLoanAllocations', {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true }, proposalId: { type: DataTypes.UUID, allowNull: false }, memberId: { type: DataTypes.UUID, allowNull: false },
      allocatedPercentage: { type: DataTypes.DECIMAL(7, 4), allowNull: false }, principalAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false }, interestAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      repaymentStatus: { type: DataTypes.ENUM('NOT_STARTED', 'ACTIVE', 'PAID', 'DEFAULTED'), allowNull: false, defaultValue: 'NOT_STARTED' }, memberAcceptance: { type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'REJECTED'), allowNull: false, defaultValue: 'PENDING' }, respondedAt: DataTypes.DATE,
      createdAt: { type: DataTypes.DATE, allowNull: false }, updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('GroupLoanProposals', ['groupId', 'status']);
    await queryInterface.addIndex('GroupLoanAllocations', ['proposalId', 'memberId'], { unique: true });
    await queryInterface.addIndex('GroupLoanAllocations', ['memberId', 'memberAcceptance']);
  },
  async down(queryInterface) {
    await queryInterface.dropTable('GroupLoanAllocations');
    await queryInterface.dropTable('GroupLoanProposals');
    await queryInterface.removeColumn('Users', 'shareCapitalStatus');
    await queryInterface.removeColumn('GroupLoans', 'proposalId');
    await queryInterface.changeColumn('GroupMemberships', 'status', { type: DataTypes.ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'LEFT', 'REMOVED'), allowNull: false, defaultValue: 'PENDING' });
  },
};
