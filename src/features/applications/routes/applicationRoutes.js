const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const applicationController = require('../controllers/applicationController');

// Routes
router.post('/', applicationController.submitApplication); // Public
router.get('/:id', applicationController.getApplicationById); // Public
router.patch('/:id', applicationController.updateApplication); // Public
router.get('/', protect, authorize(['ADMIN']), applicationController.getApplications);
router.patch('/:id/approve', protect, authorize(['ADMIN']), applicationController.approveApplication);
router.patch('/:id/reject', protect, authorize(['ADMIN']), applicationController.rejectApplication);

module.exports = router;
