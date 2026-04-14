const prisma = require('../../../shared/config/prisma');

const getAllRoles = async () => {
  return await prisma.role.findMany();
};

const getRoleById = async (id) => {
  return await prisma.role.findUnique({
    where: { id: parseInt(id) },
  });
};

const createRole = async (data) => {
  return await prisma.role.create({
    data,
  });
};

const updateRole = async (id, data) => {
  return await prisma.role.update({
    where: { id: parseInt(id) },
    data,
  });
};

const deleteRole = async (id) => {
  return await prisma.role.delete({
    where: { id: parseInt(id) },
  });
};

module.exports = {
  getAllRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
};