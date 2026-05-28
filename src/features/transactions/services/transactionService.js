const db = require('../../../models');
const { ValidationError, ConflictError } = require('../../../shared/utils/errors');

const writableFields = [
  'memberId',
  'loanId',
  'type',
  'amount',
  'method',
  'status',
  'reference',
  'description',
  'paymentCategory',
  'kcbEndpoint',
  'internalReference',
  'promptChannel',
];

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

const assertValidTransaction = (data) => {
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError('Transaction amount must be greater than zero');
  }
  if (!data.type) {
    throw new ValidationError('Transaction type is required');
  }
};

const createTransaction = async (data) => {
  assertValidTransaction(data);
  return db.sequelize.transaction(async (transaction) => {
    const references = [data.reference, data.internalReference].filter(Boolean);
    if (references.length) {
      const existing = await db.Transaction.findOne({
        where: {
          [db.Sequelize.Op.or]: [
            { reference: { [db.Sequelize.Op.in]: references } },
            { internalReference: { [db.Sequelize.Op.in]: references } },
          ],
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (existing) {
        throw new ConflictError('Duplicate transaction reference');
      }
    }

    return db.Transaction.create(pickWritable({
      ...data,
      amount: Number(data.amount),
      status: data.status || 'PENDING',
    }), { transaction });
  });
};

const updateTransaction = async (id, data) => {
  return db.sequelize.transaction(async (sequelizeTransaction) => {
    const transaction = await db.Transaction.findByPk(id, {
      transaction: sequelizeTransaction,
      lock: sequelizeTransaction.LOCK.UPDATE,
    });
    if (!transaction) return null;
    const next = pickWritable(data);
    if (next.amount !== undefined) {
      const amount = Number(next.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ValidationError('Transaction amount must be greater than zero');
      }
      next.amount = amount;
    }
    await transaction.update(next, { transaction: sequelizeTransaction });
    return transaction;
  });
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
