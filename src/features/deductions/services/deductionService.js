const db = require('../../../shared/config/db');

const createSalaryDeduction = async (data) => {
  return await db.SalaryDeduction.create({
    memberId: data.memberId,
    shareAmount: data.shareAmount,
    contribution: data.contribution,
    startDate: new Date(data.startDate),
    isActive: data.isActive ?? true,
  });
};

const getSalaryDeductions = async () => {
  return await db.SalaryDeduction.findAll({
    order: [['createdAt', 'DESC']],
  });
};

const updateSalaryDeduction = async (id, data) => {
  return await db.SalaryDeduction.update({
    shareAmount: data.shareAmount,
    contribution: data.contribution,
    startDate: data.startDate ? new Date(data.startDate) : undefined,
    isActive: data.isActive,
  }, { where: { id } });
};

const processSalaryDeductions = async () => {
  const deductions = await db.SalaryDeduction.findAll({
    where: { isActive: true },
  });

  const processed = [];

  for (const deduction of deductions) {
    const transaction = await db.Transaction.create({
      memberId: deduction.memberId,
      type: 'DEPOSIT',
      amount: deduction.contribution,
      method: 'SALARY',
      status: 'SUCCESS',
    });

    // Update savings balance
    const savings = await db.SavingsAccount.findOne({ where: { memberId: deduction.memberId } });
    if (savings) {
      await db.SavingsAccount.update({
        balance: savings.balance + deduction.contribution
      }, { where: { memberId: deduction.memberId } });
    }

    // Update shares
    const shares = await db.ShareAccount.findOne({ where: { memberId: deduction.memberId } });
    if (shares) {
      await db.ShareAccount.update({
        shares: shares.shares + (deduction.shareAmount / 100)
      }, { where: { memberId: deduction.memberId } });
    }

    processed.push({ deductionId: deduction.id, transactionId: transaction.id });
  }

  return processed;
};

module.exports = {
  createSalaryDeduction,
  getSalaryDeductions,
  updateSalaryDeduction,
  processSalaryDeductions,
};
