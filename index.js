/**
 * CRITICAL: Load environment variables FIRST
 * This must happen before any other modules are imported
 */
require('dotenv').config();

console.log(`[STARTUP] Environment loaded at ${new Date().toISOString()}`);
console.log(`[STARTUP] NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`[STARTUP] PORT: ${process.env.PORT || 3000}`);

// Now import app and start server
const app = require('./src/app');
const db = require('./src/models');

const PORT = process.env.PORT || 3000;

// Start the server
const server = app.listen(PORT, () => {
  console.log(`[STARTUP] Server is running on port ${PORT}`);
  console.log(`[STARTUP] Ready to accept requests`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received, gracefully shutting down');
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] SIGINT received, gracefully shutting down');
  server.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Sync database asynchronously (non-blocking)
db.sequelize
  .authenticate()
  .then(() => {
    console.log('[DATABASE] Connection established successfully');
    return db.sequelize.sync({ alter: process.env.NODE_ENV === 'development' });
  })
  .then(() => {
    console.log('[DATABASE] Schema synced successfully');
  })
  .catch((err) => {
    console.error('[DATABASE] Connection/sync failed:', err.message);
    console.warn('[DATABASE] Server running without database connection - some features may be unavailable');
  });
