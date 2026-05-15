/**
 * CRITICAL: Load environment variables FIRST
 * This must happen before any other modules are imported
 */
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');

// Import logger first for startup logging
const logger = require('./src/shared/utils/logger');

// Global error handlers - DO NOT EXIT PROCESS in production
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  // In production, don't exit - let the process continue
  // Railway will restart the container if needed
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', {
    reason: reason?.message || reason,
    promise: promise?.toString(),
    stack: reason?.stack,
    timestamp: new Date().toISOString()
  });
  // In production, don't exit - let the process continue
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received - initiating graceful shutdown');
  shutdown();
});

process.on('SIGINT', () => {
  logger.info('SIGINT received - initiating graceful shutdown');
  shutdown();
});

let server;

function shutdown() {
  if (server) {
    logger.info('Closing HTTP server...');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
      logger.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

// Async startup function
async function startServer() {
  try {
    logger.info('Starting Ayedos Backend Server...', {
      node_env: process.env.NODE_ENV,
      port: process.env.PORT || 3000,
      timestamp: new Date().toISOString()
    });

    // Import app after env is loaded
    const app = require('./src/app');
    const db = require('./src/models');

    // Test database connection
    logger.info('Testing database connection...');
    await db.sequelize.authenticate();
    logger.info('Database connection successful');

    // Sync database (alter in development, validate in production)
    const syncOptions = process.env.NODE_ENV === 'production'
      ? { alter: false, force: false }
      : { alter: true, force: false };

    logger.info('Syncing database schema...', { options: syncOptions });
    await db.sequelize.sync(syncOptions);
    logger.info('Database schema sync completed');

    // Railway requires binding to 0.0.0.0
    const PORT = process.env.PORT || 3000;
    const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

    // Create HTTP server
    server = createServer(app);

    // Start listening
    await new Promise((resolve, reject) => {
      server.listen(PORT, HOST, (err) => {
        if (err) {
          reject(err);
        } else {
          logger.info(`Server listening on ${HOST}:${PORT}`, {
            host: HOST,
            port: PORT,
            environment: process.env.NODE_ENV
          });
          resolve();
        }
      });
    });

    // Log successful startup
    logger.info('Server startup completed successfully', {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Failed to start server:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    // Exit with error in development, but log in production
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  }
}

// Start the server
startServer();
