'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('LoginSessions');

    if (!table.idempotencyKey) {
      await queryInterface.addColumn('LoginSessions', 'idempotencyKey', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    if (!table.refreshTokenHash) {
      await queryInterface.addColumn('LoginSessions', 'refreshTokenHash', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex('LoginSessions').catch(() => []);
    const hasIdempotencyIndex = indexes.some((index) => index.name === 'uniq_login_sessions_idempotency_key');

    if (!hasIdempotencyIndex) {
      await queryInterface.addIndex('LoginSessions', ['idempotencyKey'], {
        name: 'uniq_login_sessions_idempotency_key',
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('LoginSessions').catch(() => []);
    const hasIdempotencyIndex = indexes.some((index) => index.name === 'uniq_login_sessions_idempotency_key');

    if (hasIdempotencyIndex) {
      await queryInterface.removeIndex('LoginSessions', 'uniq_login_sessions_idempotency_key');
    }

    const table = await queryInterface.describeTable('LoginSessions');

    if (table.refreshTokenHash) {
      await queryInterface.removeColumn('LoginSessions', 'refreshTokenHash');
    }

    if (table.idempotencyKey) {
      await queryInterface.removeColumn('LoginSessions', 'idempotencyKey');
    }
  },
};
