// src/features/users/controllers/userController.js
const userService = require('../services/userService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');

const getAllUsers = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsers();
  return ResponseHandler.success(res, users, 'Users retrieved successfully', 200);
});

const getCurrentUser = asyncHandler(async (req, res) => {
  if (!req.user) {
    throw new NotFoundError('Authenticated user not found');
  }
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, user, 'Current user retrieved successfully', 200);
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, user, 'User retrieved successfully', 200);
});

const updateUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;

  if (req.user.role !== 'ADMIN' && req.user.id !== userId) {
    throw new ForbiddenError('You are not allowed to update this user');
  }

  const updateFields = [
    'firstName',
    'lastName',
    'name',
    'email',
    'phone',
    'role',
    'nationalId',
    'kraPin',
    'occupation',
    'address',
    'idDocumentUrl',
    'passportPhotoUrl',
    'consentGiven',
    'consentGivenAt'
  ];

  const hasUpdate = updateFields.some((field) => req.body[field] !== undefined);
  if (!hasUpdate) {
    throw new ValidationError('At least one field is required to update the user');
  }

  const updatedUser = await userService.updateUser(userId, req.body);
  if (!updatedUser) {
    throw new NotFoundError('User not found');
  }

  return ResponseHandler.success(res, updatedUser, 'User updated successfully', 200);
});

const deleteUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  if (req.user.role !== 'ADMIN') {
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