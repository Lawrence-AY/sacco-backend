const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const createSalaryDeduction = async (data) => {
  return await prisma.salaryDeduction.create({
    data: {
      memberId: data.memberId,
      shareAmount: data.shareAmount,
      contribution: data.contribution,
      startDate: new Date(data.startDate),
      isActive: data.isActive ?? true,
    },
  });
};

const getSalaryDeductions = async () => {
  return await prisma.salaryDeduction.findMany({
    orderBy: { createdAt: 'desc' },
  });
};

const updateSalaryDeduction = async (id, data) => {
  return await prisma.salaryDeduction.update({
    where: { id },
    data: {
      shareAmount: data.shareAmount,
      contribution: data.contribution,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      isActive: data.isActive,
    },
  });
};

const processSalaryDeductions = async () => {
  const deductions = await prisma.salaryDeduction.findMany({
    where: { isActive: true },
  });

  const processed = [];

  for (const deduction of deductions) {
    const transaction = await prisma.transaction.create({
      data: {
        memberId: deduction.memberId,
        type: 'DEPOSIT',
        amount: deduction.contribution,
        method: 'SALARY',
        status: 'SUCCESS',
      },
    });

    await prisma.savingsAccount.update({
      where: { memberId: deduction.memberId },
      data: {
        balance: { increment: deduction.contribution },
      },
    });

    await prisma.shareAccount.update({
      where: { memberId: deduction.memberId },
      data: {
        shares: { increment: deduction.shareAmount / 100 },
      },
    });

    processed.push({ deductionId: deduction.id, transactionId: transaction.id });
  }

  return { processed, count: processed.length };
};

module.exports = {
  createSalaryDeduction,
  getSalaryDeductions,
  updateSalaryDeduction,
  processSalaryDeductions,
};
