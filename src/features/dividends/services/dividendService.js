const db = require('../../../models');

const getAllDividends = async () => {
  return await db.Dividend.findAll();
};

const getDividendById = async (id) => {
  return await db.Dividend.findByPk(id);
};

const createDividend = async (data) => {
  return await db.Dividend.create(data);
};

const updateDividend = async (id, data) => {
  return await db.Dividend.update(data, { where: { id } });
};

const deleteDividend = async (id) => {
  return await db.Dividend.destroy({ where: { id } });
};

module.exports = {
  getAllDividends,
  getDividendById,
  createDividend,
  updateDividend,
  deleteDividend,
};
