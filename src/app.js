const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const { errorHandler, notFoundHandler } = require('./shared/middleware/errorMiddleware');

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

const { loginUser, refreshToken, logoutUser, registerUser, verifyOTP, resendOTP, setPassword } = require('./shared/middleware/authMiddleware');
const asyncHandler = require('./shared/utils/asyncHandler');

const app = express();

// ============= RAW BODY CAPTURE (BEFORE JSON PARSER) =============
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// ============= CORS =============
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ============= BODY PARSING MIDDLEWARE =============
app.use(express.json({ limit: '10kb' }));
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

// ============= AUTH ROUTES =============
app.use('/api/auth', authRoutes);
app.post('/api/auth/register', asyncHandler(registerUser));
app.post('/api/auth/verify-otp', asyncHandler(verifyOTP));
app.post('/api/auth/resend-otp', asyncHandler(resendOTP));
app.post('/api/auth/login', asyncHandler(loginUser));
app.post('/api/auth/refresh', asyncHandler(refreshToken));
app.post('/api/auth/logout', asyncHandler(logoutUser));
app.post('/api/auth/set-password', asyncHandler(setPassword));

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
