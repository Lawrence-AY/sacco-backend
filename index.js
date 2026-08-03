/**
 * CRITICAL: Load environment variables FIRST
 * This must happen before any other modules are imported
 */
require('dotenv').config();

const { createServer } = require('http');

// Import logger first for startup logging
const logger = require('./src/shared/utils/logger');
const { validateEnvironment } = require('./src/shared/config/env');

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getStartupErrorMessage(error) {
  return error?.parent?.message || error?.original?.message || error?.message || error?.name || 'Database startup failed';
}

function getStartupErrorDetails(error) {
  const parent = error?.parent || error?.original;
  return {
    name: error?.name,
    message: error?.message,
    parentMessage: parent?.message,
    code: parent?.code || error?.code,
    errno: parent?.errno || error?.errno,
    syscall: parent?.syscall || error?.syscall,
    address: parent?.address || error?.address,
    port: parent?.port || error?.port,
  };
}

async function initializeDatabase(app, db) {
  const retryDelayMs = Number.parseInt(process.env.DB_STARTUP_RETRY_MS, 10) || 10000;
  const maxRetries = Number.parseInt(process.env.DB_STARTUP_MAX_RETRIES, 10) || 30;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt += 1;
    try {
      // Test database connection
      logger.info('Testing database connection...');
      await db.sequelize.authenticate();
      logger.info('Database connection successful');

      if (process.env.DB_SYNC_ON_START !== 'false') {
        // Sync database (alter in development, validate in production).
        const syncOptions = process.env.NODE_ENV === 'production'
          ? { alter: false, force: false }
          : { alter: true, force: false };

        logger.info('Syncing database schema...', { options: syncOptions });
        await db.sequelize.sync(syncOptions);
        logger.info('Database schema sync completed');
      } else {
        logger.info('Skipping database schema sync because DB_SYNC_ON_START=false');
      }

      if (process.env.DB_MIGRATIONS_ON_START !== 'false') {
        await runSchemaMigrations(db.sequelize);
        logger.info('Database safety migrations completed');
      } else {
        logger.warn('Skipping database safety migrations because DB_MIGRATIONS_ON_START=false');
      }

      app.locals.apiReady = true;
      app.locals.apiStartupError = null;

      logger.info('API marked ready', {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      });
      require('./src/services/email/emailQueue').startEmailWorkers();
      return;
    } catch (error) {
      app.locals.apiReady = false;
      app.locals.apiStartupError = getStartupErrorMessage(error);

      logger.error('API startup failed:', {
        error: app.locals.apiStartupError,
        details: getStartupErrorDetails(error),
        stack: error.stack,
        timestamp: new Date().toISOString()
      });

      logger.warn('Retrying API startup after database connection failure', {
        retryDelayMs,
      });
      await delay(retryDelayMs);
    }
  }

  // Max retries exhausted — log and let the process continue
  // Railway will detect the health check failure and restart
  logger.error('Database startup failed after maximum retries', {
    maxRetries,
    retryDelayMs,
    lastError: app.locals.apiStartupError,
    timestamp: new Date().toISOString()
  });
}

// Async startup function
async function startServer() {
  try {
    logger.info('Starting Ayedos Backend Server...', {
      node_env: process.env.NODE_ENV,
      port: process.env.PORT || 3000,
      timestamp: new Date().toISOString()
    });

    validateEnvironment();

    const { testFirebaseConnection } = require('./src/shared/config/firebase');
    const firebase = await testFirebaseConnection();
    logger.info('Firebase connection successful', {
      projectId: firebase.projectId,
      service: firebase.service,
    });

    // Import app after env is loaded
    const app = require('./src/app');
    const db = require('./src/models');

    // Railway requires binding to 0.0.0.0
    const PORT = process.env.PORT || 3000;
    const HOST = process.env.HOST || '0.0.0.0';

    // Create HTTP server
    server = createServer(app);

    // Start listening
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${PORT} is already in use`, {
            host: HOST,
            port: PORT,
            hint: `Stop the process using ${HOST}:${PORT} or set PORT to another value in sacco-backend/.env`
          });
        }
        reject(error);
      };

      server.once('error', onError);
      server.listen(PORT, HOST, () => {
        server.off('error', onError);
        logger.info(`Server listening on ${HOST}:${PORT}`, {
          host: HOST,
          port: PORT,
          environment: process.env.NODE_ENV
        });
        resolve();
      });
    });

    // Log successful startup
    logger.info('HTTP server startup completed successfully', {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    });

    app.locals.apiReady = true;
    app.locals.apiStartupError = null;
    app.locals.dataBackend = 'firebase';
    logger.info('API marked ready using Firebase', {
      projectId: firebase.projectId,
    });
    require('./src/services/email/emailQueue').startEmailWorkers();

  } catch (error) {
    logger.error('Failed to start server:', {
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });

    // A process that stays alive without listening causes Railway to return
    // "Application failed to respond" instead of restarting with clear logs.
    process.exit(1);
  }
}

// Start the server
startServer();
