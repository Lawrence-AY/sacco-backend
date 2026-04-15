const app = require('./src/app');
const db = require('./src/models');

const PORT = process.env.PORT || 3000;

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Sync database asynchronously (non-blocking)
db.sequelize.sync({ alter: true }).then(() => {
  console.log('Database synced successfully');
}).catch(err => {
  console.error('Database sync failed:', err.message);
  console.warn('Server running without database');
});