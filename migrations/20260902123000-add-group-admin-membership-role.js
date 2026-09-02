'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const dialect = queryInterface.sequelize.getDialect();
    if (dialect === 'postgres') {
      await queryInterface.sequelize.query("ALTER TYPE \"enum_GroupMemberships_role\" ADD VALUE IF NOT EXISTS 'ADMIN';");
      return;
    }
    await queryInterface.changeColumn('GroupMemberships', 'role', {
      type: DataTypes.ENUM('CREATOR', 'ADMIN', 'MEMBER'),
      allowNull: false,
      defaultValue: 'MEMBER',
    });
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate('GroupMemberships', { role: 'MEMBER' }, { role: 'ADMIN' });
    if (queryInterface.sequelize.getDialect() !== 'postgres') {
      await queryInterface.changeColumn('GroupMemberships', 'role', {
        type: DataTypes.ENUM('CREATOR', 'MEMBER'),
        allowNull: false,
        defaultValue: 'MEMBER',
      });
    }
  },
};
