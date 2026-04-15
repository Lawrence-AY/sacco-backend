const { Sequelize } = require('sequelize');

// Fix DB_URL if it starts with https instead of postgres
let dbUrl = process.env.DATABASE_URL;
if (dbUrl && dbUrl.startsWith('https://')) {
  dbUrl = dbUrl.replace('https://', 'postgres://');
}

const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  },
  logging: process.env.NODE_ENV === 'development' ? console.log : false
});

module.exports = sequelize;