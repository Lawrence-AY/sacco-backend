'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkUpdate('GroupLoans', { interestRate: 1 }, {});
    await queryInterface.bulkUpdate('GroupLoanProposals', { interestRate: 1 }, {});
    await queryInterface.addConstraint('GroupLoans', {
      fields: ['interestRate'],
      type: 'check',
      where: { interestRate: 1 },
      name: 'chk_group_loans_interest_rate_fixed_1',
    });
    await queryInterface.addConstraint('GroupLoanProposals', {
      fields: ['interestRate'],
      type: 'check',
      where: { interestRate: 1 },
      name: 'chk_group_loan_proposals_interest_rate_fixed_1',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('GroupLoanProposals', 'chk_group_loan_proposals_interest_rate_fixed_1');
    await queryInterface.removeConstraint('GroupLoans', 'chk_group_loans_interest_rate_fixed_1');
  },
};
