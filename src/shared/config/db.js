const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');

// Fix DB_URL if it starts with https instead of postgres (Railway fix)
let dbUrl = process.env.DATABASE_URL;
if (dbUrl && dbUrl.startsWith('https://')) {
  dbUrl = dbUrl.replace('https://', 'postgres://');
  logger.info('Fixed DATABASE_URL protocol from https to postgres');
}

// Railway provides DATABASE_URL, but we can also support individual env vars
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  dialect: process.env.DB_DIALECT || 'postgres',
  logging: process.env.DB_LOGGING === 'true' ? (sql) => logger.debug('DB Query:', sql) : false,
  pool: {
    max: parseInt(process.env.DB_POOL_MAX) || 5,
    min: parseInt(process.env.DB_POOL_MIN) || 0,
    acquire: parseInt(process.env.DB_POOL_ACQUIRE) || 30000,
    idle: parseInt(process.env.DB_POOL_IDLE) || 10000
  },
  retry: {
    max: 3,
    timeout: 5000
  }
};

// Use DATABASE_URL if provided (Railway), otherwise construct from individual vars
let sequelize;

if (dbUrl) {
  logger.info('Using DATABASE_URL for database connection');
  sequelize = new Sequelize(dbUrl, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    },
    logging: dbConfig.logging,
    pool: dbConfig.pool,
    retry: dbConfig.retry
  });
} else {
  logger.info('Using individual DB environment variables');
  sequelize = new Sequelize(
    dbConfig.database,
    dbConfig.username,
    dbConfig.password,
    {
      host: dbConfig.host,
      port: dbConfig.port,
      dialect: dbConfig.dialect,
      logging: dbConfig.logging,
      pool: dbConfig.pool,
      retry: dbConfig.retry,
      dialectOptions: process.env.NODE_ENV === 'production' ? {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      } : {}
    }
  );
}

// Test connection function
const testConnection = async () => {
  try {
    await sequelize.authenticate();
    logger.info('Database connection test successful');
    return true;
  } catch (error) {
    logger.error('Database connection test failed:', {
      error: error.message,
      stack: error.stack
    });
    return false;
  }
};

// Graceful shutdown
const closeConnection = async () => {
  try {
    await sequelize.close();
    logger.info('Database connection closed');
  } catch (error) {
    logger.error('Error closing database connection:', error);
  }
};

module.exports = sequelize;
module.exports.testConnection = testConnection;
module.exports.closeConnection = closeConnection;
