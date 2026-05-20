const transactionService = require('../services/transactionService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');
const { TransactionDTO } = require('../../../shared/utils/dtos');

/**
 * Get all transactions
 * @route   GET /api/transactions
 * @access  Private
 */
const getAllTransactions = asyncHandler(async (req, res) => {
  const transactions = await transactionService.getAllTransactions();
  return ResponseHandler.success(res, transactions.map((item) => TransactionDTO.basic(item, req.user)), 'Transactions retrieved successfully', 200);
});

/**
 * Get transaction by ID
 * @route   GET /api/transactions/:id
 * @access  Private
 */
const getTransactionById = asyncHandler(async (req, res) => {
  const transaction = await transactionService.getTransactionById(req.params.id);
  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }
  return ResponseHandler.success(res, TransactionDTO.basic(transaction, req.user), 'Transaction retrieved successfully', 200);
});

/**
 * Create new transaction
 * @route   POST /api/transactions
 * @access  Private
 */
const createTransaction = asyncHandler(async (req, res) => {
  if (!req.body.amount || !req.body.type) {
    throw new ValidationError('Amount and type are required');
  }
  const transaction = await transactionService.createTransaction(req.body);
  return ResponseHandler.created(res, TransactionDTO.basic(transaction, req.user), 'Transaction created successfully');
});

/**
 * Update transaction
 * @route   PUT /api/transactions/:id
 * @access  Private
 */
const updateTransaction = asyncHandler(async (req, res) => {
  const transaction = await transactionService.updateTransaction(req.params.id, req.body);
  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }
  return ResponseHandler.success(res, TransactionDTO.basic(transaction, req.user), 'Transaction updated successfully', 200);
});

/**
 * Delete transaction
 * @route   DELETE /api/transactions/:id
 * @access  Private
 */
const deleteTransaction = asyncHandler(async (req, res) => {
  const result = await transactionService.deleteTransaction(req.params.id);
  if (!result) {
    throw new NotFoundError('Transaction not found');
  }
  return ResponseHandler.noContent(res);
});

module.exports = {
  getAllTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
};
