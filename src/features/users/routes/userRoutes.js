const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const { validate, schemas } = require('../../../shared/middleware/zodValidation');
const userController = require('../controllers/userController');

router.use(protect);

router.get('/me', userController.getCurrentUser);
router.get('/', authorize(['ADMIN']), userController.getAllUsers);
router.get('/:id', authorize(['ADMIN', 'FINANCE', 'MEMBER']), userController.getUserById);
router.put('/:id', validate(schemas.profileUpdate), userController.updateUser);
router.delete('/:id', authorize(['ADMIN']), userController.deleteUser);

module.exports = router;
