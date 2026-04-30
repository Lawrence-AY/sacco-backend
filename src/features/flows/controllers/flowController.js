const flowService = require('../services/flowService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');

/**
 * Get all flows
 * @route   GET /api/flows
 * @access  Private
 */
const getAllFlows = asyncHandler(async (req, res) => {
  const flows = await flowService.getAllFlows();
  return ResponseHandler.success(res, flows, 'Flows retrieved successfully', 200);
});

/**
 * Get flow by ID
 * @route   GET /api/flows/:id
 * @access  Private
 */
const getFlowById = asyncHandler(async (req, res) => {
  const flow = await flowService.getFlowById(req.params.id);
  if (!flow) {
    throw new NotFoundError('Flow not found');
  }
  return ResponseHandler.success(res, flow, 'Flow retrieved successfully', 200);
});

/**
 * Create new flow
 * @route   POST /api/flows
 * @access  Admin
 */
const createFlow = asyncHandler(async (req, res) => {
  if (!req.body.name || !req.body.type) {
    throw new ValidationError('Name and type are required');
  }
  const flow = await flowService.createFlow(req.body);
  return ResponseHandler.created(res, flow, 'Flow created successfully');
});

/**
 * Update flow
 * @route   PUT /api/flows/:id
 * @access  Admin
 */
const updateFlow = asyncHandler(async (req, res) => {
  const flow = await flowService.updateFlow(req.params.id, req.body);
  if (!flow) {
    throw new NotFoundError('Flow not found');
  }
  return ResponseHandler.success(res, flow, 'Flow updated successfully', 200);
});

/**
 * Delete flow
 * @route   DELETE /api/flows/:id
 * @access  Admin
 */
const deleteFlow = asyncHandler(async (req, res) => {
  const result = await flowService.deleteFlow(req.params.id);
  if (!result) {
    throw new NotFoundError('Flow not found');
  }
  return ResponseHandler.noContent(res);
});

module.exports = {
  getAllFlows,
  getFlowById,
  createFlow,
  updateFlow,
  deleteFlow,
};