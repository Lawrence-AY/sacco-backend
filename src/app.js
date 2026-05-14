const express = require('express');
const cors = require('cors');

// NOTE: dotenv is loaded in index.js BEFORE this module is imported
// Do NOT call dotenv.config() here to avoid timing issues

const { errorHandler, notFoundHandler } = require('./shared/middleware/errorMiddleware');

// Import email config utility (for diagnostics only - validates lazily)
const { getConfigStatus, emailLogger } = require('./shared/config/emailConfig');

const roleRoutes = require('./features/roles/routes/roleRoutes');
const transactionRoutes = require('./features/transactions/routes/transactionRoutes');
const dividendRoutes = require('./features/dividends/routes/dividendRoutes');
const flowRoutes = require('./features/flows/routes/flowRoutes');
const authRoutes = require('./features/auth/routes/authRoutes');
const applicationRoutes = require('./features/applications/routes/applicationRoutes');
const deductionRoutes = require('./features/deductions/routes/deductionRoutes');
const loanRoutes = require('./features/loans/routes/loanRoutes');
const userRoutes = require('./features/users/routes/userRoutes');
const shareRoutes = require('./features/shares/routes/shareRoutes');
const memberRoutes = require('./features/member/routes/memberRoutes');
const financeRoutes = require('./features/finance/routes/financeRoutes');
const adminRoutes = require('./features/admin/routes/adminRoutes');

const applicationController = require('./features/applications/controllers/applicationController');

const { loginUser, verifyLoginOTP, refreshToken, logoutUser, registerUser, verifyOTP, resendOTP, setPassword, protect, getSessions, revokeSession } = require('./shared/middleware/authMiddleware');

const app = express();

// ============= CORS =============
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Device-Name', 'X-Session-Id']
}));

// ============= BODY PARSING MIDDLEWARE =============
app.use(express.json({
  limit: '10kb',
  verify: (req, res, buffer) => {
    req.rawBody = buffer?.length ? buffer.toString('utf8') : '';
  } 
}));
app.use(express.urlencoded({ limit: '10kb', extended: true }));

// ============= REQUEST LOGGING (DEV) =============
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ============= HEALTH CHECK =============
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ============= DIAGNOSTICS ENDPOINT (Dev/Staging) =============
app.get('/api/diagnostics', (req, res) => {
  // Only allow in non-production or with authorization
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      message: 'Diagnostics endpoint not available in production'
    });
  }

  const emailStatus = getConfigStatus();

  res.status(200).json({
    success: true,
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT || 3000,
      CORS_ORIGIN: process.env.CORS_ORIGIN || 'not set'
    },
    email: emailStatus,
    system: {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }
  });
});

// ============= AUTH ROUTES =============
app.use('/api/auth', authRoutes);
app.post('/api/auth/register', registerUser);
app.post('/api/auth/verify-otp', verifyOTP);
app.post('/api/auth/resend-otp', resendOTP);
app.post('/api/auth/login', loginUser);
app.post('/api/auth/login/verify-otp', verifyLoginOTP);
app.post('/api/auth/refresh', refreshToken);
app.post('/api/auth/logout', protect, logoutUser);
app.post('/api/auth/set-password', setPassword);
app.get('/api/auth/sessions', protect, getSessions);
app.post('/api/auth/sessions/:sessionId/revoke', protect, revokeSession);

// ============= API ROUTES =============
app.use('/api/roles', roleRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/dividends', dividendRoutes);
app.use('/api/flows', flowRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/deductions', deductionRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/users', userRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/admin', adminRoutes);

// ============= STK STATUS ROUTE =============
app.get('/api/stk-status', applicationController.checkStkStatus);

// ============= 404 & ERROR HANDLERS =============
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
