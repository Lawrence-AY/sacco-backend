'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'postgres') {
      await queryInterface.sequelize.query("ALTER TYPE \"enum_Users_role\" ADD VALUE IF NOT EXISTS 'EMPLOYEE';");
      return;
    }

    await queryInterface.changeColumn('Users', 'role', {
      type: Sequelize.ENUM('PENDING', 'MEMBER', 'EMPLOYEE', 'FINANCE', 'ADMIN', 'SUPERADMIN'),
      defaultValue: 'PENDING',
    });
  },

  async down(queryInterface, Sequelize) {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'postgres') return;

    await queryInterface.changeColumn('Users', 'role', {
      type: Sequelize.ENUM('PENDING', 'MEMBER', 'FINANCE', 'ADMIN', 'SUPERADMIN'),
      defaultValue: 'PENDING',
    });
  },
};
