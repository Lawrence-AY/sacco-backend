const db = require('../../../models');

const writableFields = ['memberId', 'loanId', 'type', 'amount', 'method', 'status', 'reference', 'description'];

const pickWritable = (data) => writableFields.reduce((acc, field) => {
  if (data[field] !== undefined) acc[field] = data[field];
  return acc;
}, {});

const getAllTransactions = async () => {
  return await db.Transaction.findAll({ order: [['createdAt', 'DESC']] });
};

const getTransactionById = async (id) => {
  return await db.Transaction.findByPk(id);
};

const createTransaction = async (data) => {
  return await db.Transaction.create(pickWritable(data));
};

const updateTransaction = async (id, data) => {
  const transaction = await db.Transaction.findByPk(id);
  if (!transaction) return null;
  await transaction.update(pickWritable(data));
  return transaction;
};

const deleteTransaction = async (id) => {
  return await db.Transaction.destroy({ where: { id } });
};

module.exports = {
  getAllTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
};
