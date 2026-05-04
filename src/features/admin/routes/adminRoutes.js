const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const adminController = require('../controllers/adminController');

const router = express.Router();
router.use(protect, authorize(['ADMIN']));

router.get('/users', adminController.getAllUsers);
router.get('/users/:userId', adminController.getUserById);
router.put('/users/:userId/role', adminController.updateUserRole);
router.put('/users/:userId/status', adminController.updateUserStatus);

router.get('/applications', adminController.getAllApplications);
router.post('/applications/:applicationId/review', adminController.reviewApplication);
router.get('/stats', adminController.getSystemStats);

module.exports = router;
