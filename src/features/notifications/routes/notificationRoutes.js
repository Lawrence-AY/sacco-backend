const express = require('express');
const { protect } = require('../../../shared/middleware/authMiddleware');
const notificationController = require('../controllers/notificationController');

const router = express.Router();

router.use(protect);
router.get('/', notificationController.listNotifications);
router.post('/read-all', notificationController.markAllNotificationsRead);
router.post('/:notificationId/read', notificationController.markNotificationRead);

module.exports = router;
