'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Members');
    if (!table.importProfile) {
      await queryInterface.addColumn('Members', 'importProfile', {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Members');
    if (table.importProfile) {
      await queryInterface.removeColumn('Members', 'importProfile');
    }
  },
};
