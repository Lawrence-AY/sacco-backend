const express = require('express');
const router = express.Router();

// Import controllers
const flowController = require('../controllers/flowController');

// Routes
router.get('/', flowController.getAllFlows);
router.get('/:id', flowController.getFlowById);
router.post('/', flowController.createFlow);
router.put('/:id', flowController.updateFlow);
router.delete('/:id', flowController.deleteFlow);

module.exports = router;