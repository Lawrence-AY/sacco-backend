const express = require('express');
const router = express.Router();

// Import controllers
const roleController = require('../controllers/roleController');

// Routes
router.get('/', roleController.getAllRoles);
router.get('/:id', roleController.getRoleById);
router.post('/', roleController.createRole);
router.put('/:id', roleController.updateRole);
router.delete('/:id', roleController.deleteRole);

module.exports = router;