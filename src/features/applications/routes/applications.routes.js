const express = require('express');
const applicationsController = require('../controllers/applications.controller');
const authMiddleware = require('../../../shared/middleware/authMiddleware');

const router = express.Router();

// Public routes
router.post('/', applicationsController.createApplication);
router.get('/:applicationId', applicationsController.getApplication);
router.get('/:applicationId/status', applicationsController.getApplicationStatus);

// Protected routes - user can verify payment for their own application
router.post('/:applicationId/verify-payment', applicationsController.verifyPayment);
router.post('/:applicationId/submit', applicationsController.submitApplication);

// Admin-only routes
router.use(authMiddleware.protect, authMiddleware.admin);
router.get('/', applicationsController.getApplications);
router.post('/:applicationId/approve', applicationsController.approveApplication);
router.post('/:applicationId/reject', applicationsController.rejectApplication);

module.exports = router;
