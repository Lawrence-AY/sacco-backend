const loanService = require('../services/loanService');

const getLoans = async (req, res) => {
  try {
    const loans = await loanService.getAllLoans();
    res.json(loans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getLoanById = async (req, res) => {
  try {
    const loan = await loanService.getLoanById(req.params.id);
    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }
    res.json(loan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createLoan = async (req, res) => {
  try {
    const loan = await loanService.createLoan(req.body);
    res.status(201).json(loan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateLoan = async (req, res) => {
  try {
    const loan = await loanService.updateLoan(req.params.id, req.body);
    res.json(loan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const approveLoan = async (req, res) => {
  try {
    const loan = await loanService.updateLoanStatus(req.params.id, 'APPROVED');
    res.json(loan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const rejectLoan = async (req, res) => {
  try {
    const loan = await loanService.updateLoanStatus(req.params.id, 'REJECTED');
    res.json(loan);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  getLoans,
  getLoanById,
  createLoan,
  updateLoan,
  approveLoan,
  rejectLoan,
};
