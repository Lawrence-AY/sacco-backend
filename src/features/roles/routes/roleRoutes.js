const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');

// Import controllers
const roleController = require('../controllers/roleController');

// All routes require authentication
router.use(protect);

// Routes
router.get('/', roleController.getAllRoles);
router.get('/:id', roleController.getRoleById);
router.post('/', authorize(['ADMIN']), roleController.createRole);
router.put('/:id', authorize(['ADMIN']), roleController.updateRole);
router.delete('/:id', authorize(['ADMIN']), roleController.deleteRole);

module.exports = router;