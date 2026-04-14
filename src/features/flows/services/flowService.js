const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getAllFlows = async () => {
  return await prisma.flow.findMany();
};

const getFlowById = async (id) => {
  return await prisma.flow.findUnique({
    where: { id: parseInt(id) },
  });
};

const createFlow = async (data) => {
  return await prisma.flow.create({
    data,
  });
};

const updateFlow = async (id, data) => {
  return await prisma.flow.update({
    where: { id: parseInt(id) },
    data,
  });
};

const deleteFlow = async (id) => {
  return await prisma.flow.delete({
    where: { id: parseInt(id) },
  });
};

module.exports = {
  getAllFlows,
  getFlowById,
  createFlow,
  updateFlow,
  deleteFlow,
};