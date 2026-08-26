module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('IdentityVerificationAttempts', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      email: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      documentType: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      documentNumber: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      firstName: Sequelize.STRING,
      surname: Sequelize.STRING,
      attemptCount: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: Sequelize.ENUM('FAILED', 'BLOCKED', 'RESET', 'VERIFIED'),
        allowNull: false,
        defaultValue: 'FAILED',
      },
      blockStatus: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      reason: Sequelize.TEXT,
      failureReason: Sequelize.TEXT,
      ipAddress: Sequelize.STRING,
      blockedAt: Sequelize.DATE,
      resetAt: Sequelize.DATE,
      resetById: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
    await queryInterface.addIndex('IdentityVerificationAttempts', ['email']);
    await queryInterface.addIndex('IdentityVerificationAttempts', ['documentNumber']);
    await queryInterface.addIndex('IdentityVerificationAttempts', ['status']);
    await queryInterface.addIndex('IdentityVerificationAttempts', ['blockStatus']);
    await queryInterface.addIndex('IdentityVerificationAttempts', ['createdAt']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('IdentityVerificationAttempts');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_IdentityVerificationAttempts_status";');
  },
};
