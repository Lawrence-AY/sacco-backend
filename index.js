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
    let firebase;
    try {
      firebase = await testFirebaseConnection();
      logger.info('Firebase connection successful', {
        projectId: firebase.projectId,
        service: firebase.service,
      });
    } catch (error) {
      if (process.env.NODE_ENV === 'production') throw error;
      firebase = {
        connected: false,
        projectId: process.env.FIREBASE_PROJECT_ID || null,
        service: 'firebase-admin',
      };
      logger.warn('Firebase remote credential check failed; continuing local startup', {
        error: error.message,
        hint: 'Firebase requests may fail until network access to oauth2.googleapis.com is available.',
      });
    }

    // Import app after env is loaded
    const app = require('./src/app');
    const db = require('./src/models');

    // Railway requires binding to 0.0.0.0; local development is safer on localhost.
    const PORT = Number(process.env.PORT || 3000);
    const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

    // Start listening
    const listen = (port) => new Promise((resolve, reject) => {
      const candidateServer = createServer(app);
      const onError = (error) => {
        candidateServer.off('listening', onListening);
        candidateServer.close(() => {});
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${port} is already in use`, {
            host: HOST,
            port,
            hint: `Stop the process using ${HOST}:${port} or set PORT to another value in sacco-backend/.env`
          });
        }
        reject(error);
      };
      const onListening = () => {
        candidateServer.off('error', onError);
        server = candidateServer;
        logger.info(`Server listening on ${HOST}:${port}`, {
          host: HOST,
          port,
          environment: process.env.NODE_ENV
        });
        resolve(port);
      };

      candidateServer.once('error', onError);
      candidateServer.once('listening', onListening);
      candidateServer.listen(port, HOST);
    });
    const maxPortAttempts = process.env.NODE_ENV === 'production' ? 1 : Number(process.env.PORT_RETRY_ATTEMPTS || 10);
    let activePort = PORT;
    for (let attempt = 0; attempt < maxPortAttempts; attempt += 1) {
      try {
        activePort = await listen(PORT + attempt);
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || attempt === maxPortAttempts - 1) throw error;
        logger.warn('Trying next development port', { nextPort: PORT + attempt + 1 });
      }
    }
    process.env.PORT = String(activePort);

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
    const overdueMonitor = require('./src/features/notifications/services/notificationService').createOverdueLoanAlerts;
    overdueMonitor().catch((error) => logger.error('Initial overdue-loan alert scan failed', { error: error.message }));
    const overdueMonitorTimer = setInterval(() => overdueMonitor().catch((error) => logger.error('Overdue-loan alert scan failed', { error: error.message })), 60 * 60 * 1000);
    overdueMonitorTimer.unref();

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
