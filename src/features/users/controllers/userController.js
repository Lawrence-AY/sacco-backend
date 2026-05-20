// src/features/users/controllers/userController.js
const userService = require('../services/userService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const { UserDTO } = require('../../../shared/utils/dtos');

const getAllUsers = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsers();
  return ResponseHandler.success(res, users.map(UserDTO.admin), 'Users retrieved successfully', 200);
});

const getCurrentUser = asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new NotFoundError('Authenticated user not found');
  }
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.private(user), 'Current user retrieved successfully', 200);
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  if (req.user.role === 'MEMBER' && req.user.id !== req.params.id) {
    throw new ForbiddenError('You are not allowed to view this user');
  }
  const dto = ['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(req.user.role)
    ? UserDTO.admin(user)
    : UserDTO.private(user);
  return ResponseHandler.success(res, dto, 'User retrieved successfully', 200);
});

const updateUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;

  if (!['ADMIN', 'SUPERADMIN'].includes(req.user.role) && req.user.id !== userId) {
    throw new ForbiddenError('You are not allowed to update this user');
  }

  const selfUpdateFields = [
    'firstName',
    'lastName',
    'name',
    'email',
    'phone',
    'nationalId',
    'kraPin',
    'occupation',
    'address',
    'consentGiven',
  ];
  const adminUpdateFields = [...selfUpdateFields, 'role', 'isVerified'];
  const updateFields = ['ADMIN', 'SUPERADMIN'].includes(req.user.role)
    ? adminUpdateFields
    : selfUpdateFields;

  const safeBody = updateFields.reduce((acc, field) => {
    if (req.body[field] !== undefined) acc[field] = req.body[field];
    return acc;
  }, {});

  const hasUpdate = Object.keys(safeBody).length > 0;
  if (!hasUpdate) {
    throw new ValidationError('At least one field is required to update the user');
  }

  const updatedUser = await userService.updateUser(userId, safeBody);
  if (!updatedUser) {
    throw new NotFoundError('User not found');
  }

  return ResponseHandler.success(res, UserDTO.private(updatedUser), 'User updated successfully', 200);
});

const deleteUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  if (!['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
    throw new ForbiddenError('Only admins can delete users');
  }

  const deleted = await userService.deleteUser(userId);
  if (!deleted) {
    throw new NotFoundError('User not found');
  }

  return ResponseHandler.noContent(res);
});

module.exports = {
  getAllUsers,
  getCurrentUser,
  getUserById,
  updateUser,
  deleteUser
};
