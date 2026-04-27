const express = require('express');

const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const shareController = require('../controllers/shareController');

const router = express.Router();

router.use(protect);
router.get('/', authorize(['ADMIN', 'FINANCE', 'MEMBER']), shareController.getShares);

module.exports = router;
