const db = require('../../../shared/config/db');

const getAllFlows = async () => {
  return await db.Transaction.findAll();
};

const getFlowById = async (id) => {
  return await db.Transaction.findByPk(id);
};

const createFlow = async (data) => {
  return await db.Transaction.create(data);
};

const updateFlow = async (id, data) => {
  return await db.Transaction.update(data, { where: { id } });
};

const deleteFlow = async (id) => {
  return await db.Transaction.destroy({ where: { id } });
};

module.exports = {
  getAllFlows,
  getFlowById,
  createFlow,
  updateFlow,
  deleteFlow,
};