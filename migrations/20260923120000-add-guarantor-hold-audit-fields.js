'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Guarantors');
    if (!table.cancellationReason) await queryInterface.addColumn('Guarantors', 'cancellationReason', { type: Sequelize.TEXT, allowNull: true });
    if (!table.holdPlacedAt) await queryInterface.addColumn('Guarantors', 'holdPlacedAt', { type: Sequelize.DATE, allowNull: true });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Guarantors');
    if (table.holdPlacedAt) await queryInterface.removeColumn('Guarantors', 'holdPlacedAt');
    if (table.cancellationReason) await queryInterface.removeColumn('Guarantors', 'cancellationReason');
  },
};
