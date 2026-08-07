const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const adminController = require('../controllers/adminController');

const router = express.Router();
router.use(protect, authorize(['ADMIN', 'SUPERADMIN']));

router.get('/users', adminController.getAllUsers);
router.get('/users/:userId', adminController.getUserById);
router.put('/users/:userId/role', validate(schemas.roleUpdate), adminController.updateUserRole);
router.put('/users/:userId/status', validate(schemas.statusUpdate), adminController.updateUserStatus);

router.get('/applications', adminController.getAllApplications);
router.post('/applications/:applicationId/review', adminController.reviewApplication);
router.get('/stats', adminController.getSystemStats);
router.post('/members/import/preview', adminController.previewMemberCsvImport);
router.post('/members/import/commit', adminController.commitMemberCsvImport);
router.post('/financial-import/preview', adminController.previewFinancialCsvImport);
router.post('/financial-import/commit', adminController.commitFinancialCsvImport);
router.get('/notifications', adminController.listNotifications);
router.post('/notifications/read-all', adminController.markAllNotificationsRead);
router.post('/notifications/:notificationId/read', adminController.markNotificationRead);

module.exports = router;
