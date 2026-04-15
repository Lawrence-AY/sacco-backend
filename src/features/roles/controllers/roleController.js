const roleService = require('../services/roleService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');

/**
 * Get all roles
 * @route   GET /api/roles
 * @access  Private
 */
const getAllRoles = asyncHandler(async (req, res) => {
  const roles = await roleService.getAllRoles();
  return ResponseHandler.success(res, roles, 'Roles retrieved successfully', 200);
});

/**
 * Get role by ID
 * @route   GET /api/roles/:id
 * @access  Private
 */
const getRoleById = asyncHandler(async (req, res) => {
  const role = await roleService.getRoleById(req.params.id);
  if (!role) {
    throw new NotFoundError('Role not found');
  }
  return ResponseHandler.success(res, role, 'Role retrieved successfully', 200);
});

/**
 * Create new role
 * @route   POST /api/roles
 * @access  Admin
 */
const createRole = asyncHandler(async (req, res) => {
  if (!req.body.name) {
    throw new ValidationError('Role name is required');
  }
  const role = await roleService.createRole(req.body);
  return ResponseHandler.created(res, role, 'Role created successfully');
});

/**
 * Update role
 * @route   PUT /api/roles/:id
 * @access  Admin
 */
const updateRole = asyncHandler(async (req, res) => {
  const role = await roleService.updateRole(req.params.id, req.body);
  if (!role) {
    throw new NotFoundError('Role not found');
  }
  return ResponseHandler.success(res, role, 'Role updated successfully', 200);
});

/**
 * Delete role
 * @route   DELETE /api/roles/:id
 * @access  Admin
 */
const deleteRole = asyncHandler(async (req, res) => {
  const result = await roleService.deleteRole(req.params.id);
  if (!result) {
    throw new NotFoundError('Role not found');
  }
  return ResponseHandler.noContent(res);
});

module.exports = {
  getAllRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
};