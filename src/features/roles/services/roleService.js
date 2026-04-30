const db = require('../../../models');

const getAllRoles = async () => {
  return await db.Role.findAll();
};

const getRoleById = async (id) => {
  return await db.Role.findByPk(id);
};

module.exports = {
  getAllRoles,
  getRoleById,
};
