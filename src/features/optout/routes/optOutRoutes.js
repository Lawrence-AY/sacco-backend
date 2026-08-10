const express = require('express');
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const controller = require('../controllers/optOutController');
const router = express.Router();
router.use(protect, authorize(['ADMIN', 'SUPERADMIN', 'FINANCE']));
router.get('/', controller.list);
router.patch('/:requestId/review', controller.review);
router.post('/:requestId/disburse', controller.disburse);
module.exports = router;
