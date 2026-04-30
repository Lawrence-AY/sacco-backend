const db = require('../../../models');

const getAllTransactions = async () => {
  return await db.Transaction.findAll();
};

const getTransactionById = async (id) => {
  return await db.Transaction.findByPk(id);
};

const createTransaction = async (data) => {
  return await db.Transaction.create(data);
};

const updateTransaction = async (id, data) => {
  return await db.Transaction.update(data, { where: { id } });
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
