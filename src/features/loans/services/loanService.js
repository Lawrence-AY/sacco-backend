const prisma = require('../../../shared/config/prisma');

const getAllLoans = async () => {
  return await prisma.loan.findMany({
    include: { guarantors: true },
    orderBy: { createdAt: 'desc' },
  });
};

const getLoanById = async (id) => {
  return await prisma.loan.findUnique({
    where: { id },
    include: { guarantors: true },
  });
};

const createLoan = async (data) => {
  return await prisma.loan.create({
    data: {
      memberId: data.memberId,
      amount: data.amount,
      interestRate: data.interestRate,
      duration: data.duration,
      status: data.status || 'PENDING',
      type: data.type,
      multiplier: data.multiplier,
      approvedById: data.approvedById,
      approvalStage: data.approvalStage || 'INITIAL',
      guarantors: {
        create: (data.guarantors || []).map((guarantor) => ({
          memberId: guarantor.memberId,
          amount: guarantor.amount,
        })),
      },
    },
    include: { guarantors: true },
  });
};

const updateLoan = async (id, data) => {
  return await prisma.loan.update({
    where: { id },
    data: {
      amount: data.amount,
      interestRate: data.interestRate,
      duration: data.duration,
      status: data.status,
      type: data.type,
      multiplier: data.multiplier,
      approvalStage: data.approvalStage,
    },
  });
};

const updateLoanStatus = async (id, status) => {
  return await prisma.loan.update({
    where: { id },
    data: { status },
  });
};

module.exports = {
  getAllLoans,
  getLoanById,
  createLoan,
  updateLoan,
  updateLoanStatus,
};
