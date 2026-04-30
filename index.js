const app = require('./src/app');
const db = require('./src/models');

const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL;

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}, ${DB_URL}`);
});

// Sync database asynchronously (non-blocking)
db.sequelize.authenticate().then(() => {
  console.log('Database connection established successfully');
  return db.sequelize.sync({ alter: process.env.NODE_ENV === 'development' });
}).then(() => {
  console.log('Database synced successfully');
}).catch(err => {
  console.error('Database connection/sync failed:', err.message);
  console.error('Full error:', err);
  console.warn('Server running without database connection');
});