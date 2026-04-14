const express = require('express');
const router = express.Router();
const applicationController = require('../controllers/applicationController');

router.post('/', applicationController.submitApplication);
router.get('/', applicationController.getApplications);
router.patch('/:id/approve', applicationController.approveApplication);
router.patch('/:id/reject', applicationController.rejectApplication);

module.exports = router;
