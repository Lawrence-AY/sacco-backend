const dividendService = require('../services/dividendService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');

/**
 * Get all dividends
 * @route   GET /api/dividends
 * @access  Private
 */
const getAllDividends = asyncHandler(async (req, res) => {
  const dividends = await dividendService.getAllDividends();
  return ResponseHandler.success(res, dividends, 'Dividends retrieved successfully', 200);
});

/**
 * Get dividend by ID
 * @route   GET /api/dividends/:id
 * @access  Private
 */
const getDividendById = asyncHandler(async (req, res) => {
  const dividend = await dividendService.getDividendById(req.params.id);
  if (!dividend) {
    throw new NotFoundError('Dividend not found');
  }
  return ResponseHandler.success(res, dividend, 'Dividend retrieved successfully', 200);
});

/**
 * Create new dividend
 * @route   POST /api/dividends
 * @access  Admin
 */
const createDividend = asyncHandler(async (req, res) => {
  if (!req.body.amount || !req.body.memberId) {
    throw new ValidationError('Amount and memberId are required');
  }
  const dividend = await dividendService.createDividend(req.body);
  return ResponseHandler.created(res, dividend, 'Dividend created successfully');
});

/**
 * Update dividend
 * @route   PUT /api/dividends/:id
 * @access  Admin
 */
const updateDividend = asyncHandler(async (req, res) => {
  const dividend = await dividendService.updateDividend(req.params.id, req.body);
  if (!dividend) {
    throw new NotFoundError('Dividend not found');
  }
  return ResponseHandler.success(res, dividend, 'Dividend updated successfully', 200);
});

/**
 * Delete dividend
 * @route   DELETE /api/dividends/:id
 * @access  Admin
 */
const deleteDividend = asyncHandler(async (req, res) => {
  const result = await dividendService.deleteDividend(req.params.id);
  if (!result) {
    throw new NotFoundError('Dividend not found');
  }
  return ResponseHandler.noContent(res);
});

module.exports = {
  getAllDividends,
  getDividendById,
  createDividend,
  updateDividend,
  deleteDividend,
};