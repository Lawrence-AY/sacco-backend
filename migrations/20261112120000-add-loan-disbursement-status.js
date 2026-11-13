'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Loans');
    if (!table.disbursementStatus) {
      await queryInterface.addColumn('Loans', 'disbursementStatus', {
        type: Sequelize.ENUM('PENDING', 'COMPLETE', 'DENIED'),
        allowNull: false,
        defaultValue: 'PENDING',
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Loans');
    if (table.disbursementStatus) await queryInterface.removeColumn('Loans', 'disbursementStatus');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Loans_disbursementStatus";');
  },
};
