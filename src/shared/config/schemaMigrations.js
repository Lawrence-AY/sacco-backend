const { DataTypes } = require('sequelize');
const logger = require('../utils/logger');

const userColumns = {
  dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
  gender: { type: DataTypes.STRING, allowNull: true },
  employer: { type: DataTypes.STRING, allowNull: true },
  monthlyIncome: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  payrollNumber: { type: DataTypes.STRING, allowNull: true },
  nextOfKinName: { type: DataTypes.STRING, allowNull: true },
  nextOfKinRelationship: { type: DataTypes.STRING, allowNull: true },
  nextOfKinPhone: { type: DataTypes.STRING, allowNull: true },
};

const ensureUserProfileColumns = async (sequelize) => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable('Users');

  for (const [column, definition] of Object.entries(userColumns)) {
    if (!table[column]) {
      await queryInterface.addColumn('Users', column, definition);
      logger.info('Added missing Users profile column', { column });
    }
  }

  if (table.idDocumentUrl?.type && !String(table.idDocumentUrl.type).toUpperCase().includes('TEXT')) {
    await queryInterface.changeColumn('Users', 'idDocumentUrl', { type: DataTypes.TEXT, allowNull: true });
    logger.info('Expanded Users.idDocumentUrl to TEXT');
  }

  if (table.passportPhotoUrl?.type && !String(table.passportPhotoUrl.type).toUpperCase().includes('TEXT')) {
    await queryInterface.changeColumn('Users', 'passportPhotoUrl', { type: DataTypes.TEXT, allowNull: true });
    logger.info('Expanded Users.passportPhotoUrl to TEXT');
  }
};

const runSchemaMigrations = async (sequelize) => {
  await ensureUserProfileColumns(sequelize);
};

module.exports = {
  runSchemaMigrations,
};
