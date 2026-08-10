const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const notificationService = require('../services/notificationService');

const listNotifications = asyncHandler(async (req, res) => {
  const notifications = await notificationService.listForUser(req.user, {
    unreadOnly: req.query.unreadOnly === 'true',
    limit: req.query.limit,
  });
  return ResponseHandler.success(res, notifications, 'Notifications retrieved successfully');
});

const listSentNotifications = asyncHandler(async (req, res) => {
  const notifications = await notificationService.listSentByUser(req.user, { limit: req.query.limit });
  return ResponseHandler.success(res, notifications, 'Sent notifications retrieved successfully');
});

const markNotificationRead = asyncHandler(async (req, res) => {
  const notification = await notificationService.markRead(req.user, req.params.notificationId);
  return ResponseHandler.success(res, notification, 'Notification marked as read');
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  await notificationService.markAllRead(req.user);
  return ResponseHandler.success(res, null, 'Notifications marked as read');
});

const sendNotification = asyncHandler(async (req, res) => {
  const result = await notificationService.createManualNotification(req.user, req.body);
  return ResponseHandler.created(res, result, 'Notification sent successfully');
});

module.exports = {
  listNotifications,
  listSentNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  sendNotification,
};
