const prisma = require('../../../shared/config/prisma');

const getAllTransactions = async () => {
  return await prisma.transaction.findMany();
};

const getTransactionById = async (id) => {
  return await prisma.transaction.findUnique({
    where: { id: parseInt(id) },
  });
};

const createTransaction = async (data) => {
  return await prisma.transaction.create({
    data,
  });
};

const updateTransaction = async (id, data) => {
  return await prisma.transaction.update({
    where: { id: parseInt(id) },
    data,
  });
};

const deleteTransaction = async (id) => {
  return await prisma.transaction.delete({
    where: { id: parseInt(id) },
  });
};

module.exports = {
  getAllTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
};