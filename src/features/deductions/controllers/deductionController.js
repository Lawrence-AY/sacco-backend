const deductionService = require('../services/deductionService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError } = require('../../../shared/utils/errors');

/**
 * Create new salary deduction
 * @route   POST /api/deductions
 * @access  Admin/Finance
 */
const createDeduction = asyncHandler(async (req, res) => {
  if (!req.body.memberId || !req.body.amount) {
    throw new ValidationError('MemberId and amount are required');
  }
  const deduction = await deductionService.createSalaryDeduction(req.body);
  return ResponseHandler.created(res, deduction, 'Salary deduction created successfully');
});

/**
 * Get all salary deductions
 * @route   GET /api/deductions
 * @access  Private
 */
const getDeductions = asyncHandler(async (req, res) => {
  const deductions = await deductionService.getSalaryDeductions();
  return ResponseHandler.success(res, deductions, 'Salary deductions retrieved successfully', 200);
});

/**
 * Update salary deduction
 * @route   PUT /api/deductions/:id
 * @access  Admin/Finance
 */
const updateDeduction = asyncHandler(async (req, res) => {
  const deduction = await deductionService.updateSalaryDeduction(req.params.id, req.body);
  return ResponseHandler.success(res, deduction, 'Salary deduction updated successfully', 200);
});

/**
 * Process all pending salary deductions
 * @route   POST /api/deductions/process/run
 * @access  Admin/Finance
 */
const runDeductions = asyncHandler(async (req, res) => {
  const result = await deductionService.processSalaryDeductions();
  return ResponseHandler.success(res, result, 'Salary deductions processed successfully', 200);
});

module.exports = {
  createDeduction,
  getDeductions,
  updateDeduction,
  runDeductions,
};
