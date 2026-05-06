// src/features/applications/routes/applicationRoutes.js
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const applicationController = require('../controllers/applicationController');

// ✅ FORCE JSON PARSING FOR THIS SPECIFIC ROUTE
router.post('/:id/verify-payment', express.json(), applicationController.verifyPayment);

// Public routes (specific paths before generic :id)
router.post('/', applicationController.submitApplication);
router.get('/stk-status', applicationController.checkStkStatus);
router.get('/:id', applicationController.getApplicationById);
router.patch('/:id', applicationController.updateApplication);

// Admin only routes
router.get('/', protect, authorize(['ADMIN']), applicationController.getApplications);
router.patch('/:id/approve', protect, authorize(['ADMIN']), applicationController.approveApplication);
router.patch('/:id/reject', protect, authorize(['ADMIN']), applicationController.rejectApplication);

module.exports = router;