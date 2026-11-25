'use strict';

module.exports = {
  async up(queryInterface) {
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query("ALTER TYPE \"enum_Users_role\" ADD VALUE IF NOT EXISTS 'SECRETARY';");
    }
  },
  async down() {},
};
