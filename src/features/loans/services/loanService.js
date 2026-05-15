const db = require('../../../models');

const getAllLoans = async () => {
  return await db.Loan.findAll({
    include: [db.Guarantor],
    order: [['createdAt', 'DESC']],
  });
};

const getLoanById = async (id) => {
  return await db.Loan.findByPk(id, {
    include: [db.Guarantor],
  });
};

const createLoan = async (data) => {
  const loan = await db.Loan.create({
    memberId: data.memberId,
    amount: data.amount,
    interestRate: data.interestRate,
    duration: data.duration,
    status: data.status || 'PENDING',
    type: data.type,
    multiplier: data.multiplier,
    approvedById: data.approvedById,
    approvalStage: data.approvalStage || 'INITIAL',
  });

  if (data.guarantors && data.guarantors.length > 0) {
    for (const guarantor of data.guarantors) {
      await db.Guarantor.create({
        loanId: loan.id,
        memberId: guarantor.memberId,
        amount: guarantor.amount,
      });
    }
  }

  return loan;
};

const updateLoan = async (id, data) => {
  const loan = await db.Loan.findByPk(id);
  if (!loan) return null;
  await loan.update({
    amount: data.amount,
    interestRate: data.interestRate,
    duration: data.duration,
    status: data.status,
    type: data.type,
    multiplier: data.multiplier,
    approvalStage: data.approvalStage,
    approvedById: data.approvedById,
  });
  return loan;
};

const deleteLoan = async (id) => {
  return await db.Loan.destroy({ where: { id } });
};

const updateLoanStatus = async (id, status) => {
  const loan = await db.Loan.findByPk(id);
  if (!loan) return null;
  await loan.update({ status });
  return loan;
};

module.exports = {
  getAllLoans,
  getLoanById,
  createLoan,
  updateLoan,
  deleteLoan,
  updateLoanStatus,
};
