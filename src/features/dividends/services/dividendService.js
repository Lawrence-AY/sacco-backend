const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getAllDividends = async () => {
  return await prisma.dividend.findMany();
};

const getDividendById = async (id) => {
  return await prisma.dividend.findUnique({
    where: { id: parseInt(id) },
  });
};

const createDividend = async (data) => {
  return await prisma.dividend.create({
    data,
  });
};

const updateDividend = async (id, data) => {
  return await prisma.dividend.update({
    where: { id: parseInt(id) },
    data,
  });
};

const deleteDividend = async (id) => {
  return await prisma.dividend.delete({
    where: { id: parseInt(id) },
  });
};

module.exports = {
  getAllDividends,
  getDividendById,
  createDividend,
  updateDividend,
  deleteDividend,
};