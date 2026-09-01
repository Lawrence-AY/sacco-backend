module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Users');
    if (!table.employmentTag) {
      await queryInterface.addColumn('Users', 'employmentTag', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Users');
    if (table.employmentTag) {
      await queryInterface.removeColumn('Users', 'employmentTag');
    }
  },
};
