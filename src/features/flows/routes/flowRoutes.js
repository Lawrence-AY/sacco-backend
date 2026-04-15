const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');

// Import controllers
const flowController = require('../controllers/flowController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', flowController.getAllFlows);
router.get('/:id', flowController.getFlowById);
router.post('/', authorize(['ADMIN']), flowController.createFlow);
router.put('/:id', authorize(['ADMIN']), flowController.updateFlow);
router.delete('/:id', authorize(['ADMIN']), flowController.deleteFlow);

module.exports = router;