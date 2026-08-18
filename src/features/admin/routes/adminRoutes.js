const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const adminController = require('../controllers/adminController');

const router = express.Router();

const csvImportPolicyHeaders = (req, res, next) => {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

router.use(['/members/import', '/financial-import'], csvImportPolicyHeaders);
router.use(protect, authorize(['ADMIN', 'SUPERADMIN']));

router.get('/users', adminController.getAllUsers);
router.get('/members/archived', adminController.getArchivedMembers);
router.get('/audit-logs', adminController.getAuditLogs);
router.get('/users/:userId', adminController.getUserById);
router.put('/users/:userId/role', validate(schemas.roleUpdate), adminController.updateUserRole);
router.put('/users/:userId/status', validate(schemas.statusUpdate), adminController.updateUserStatus);

router.get('/applications', adminController.getAllApplications);
router.post('/applications/:applicationId/review', adminController.reviewApplication);
router.get('/stats', adminController.getSystemStats);
// Admin CSV import provisions new member accounts and initializes baseline SACCO records.
router.post('/members/import/preview', adminController.previewMemberCsvImport);
router.post('/members/import/commit', adminController.commitMemberCsvImport);
// Finance CSV import posts periodic financial data to existing member accounts and ledgers.
router.post('/financial-import/preview', adminController.previewFinancialCsvImport);
router.post('/financial-import/commit', adminController.commitFinancialCsvImport);
router.get('/notifications', adminController.listNotifications);
router.post('/notifications/broadcast', adminController.sendBroadcastNotification);
router.post('/notifications/direct', adminController.sendDirectNotification);
router.post('/notifications/read-all', adminController.markAllNotificationsRead);
router.post('/notifications/:notificationId/read', adminController.markNotificationRead);
router.get('/financial-portfolio', adminController.getFinancialPortfolio);
router.get('/portfolio', adminController.getFinancialPortfolio);
router.post('/portfolio', adminController.upsertPortfolio);
router.put('/portfolio', adminController.upsertPortfolio);
router.put('/financial-portfolio/:year/reports', adminController.upsertFinancialPortfolioReports);
router.post('/financial-portfolio/:year/dividends', adminController.upsertMemberDividends);

module.exports = router;
