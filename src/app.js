const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Import routes
const roleRoutes = require('./features/roles/routes/roleRoutes');
const transactionRoutes = require('./features/transactions/routes/transactionRoutes');
const dividendRoutes = require('./features/dividends/routes/dividendRoutes');
const flowRoutes = require('./features/flows/routes/flowRoutes');
const applicationRoutes = require('./features/applications/routes/applicationRoutes');
const deductionRoutes = require('./features/deductions/routes/deductionRoutes');
const loanRoutes = require('./features/loans/routes/loanRoutes');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/roles', roleRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/dividends', dividendRoutes);
app.use('/api/flows', flowRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/deductions', deductionRoutes);
app.use('/api/loans', loanRoutes);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

module.exports = app;