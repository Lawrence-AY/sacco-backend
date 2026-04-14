const deductionService = require('../services/deductionService');

const createDeduction = async (req, res) => {
  try {
    const deduction = await deductionService.createSalaryDeduction(req.body);
    res.status(201).json(deduction);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getDeductions = async (req, res) => {
  try {
    const deductions = await deductionService.getSalaryDeductions();
    res.json(deductions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateDeduction = async (req, res) => {
  try {
    const deduction = await deductionService.updateSalaryDeduction(req.params.id, req.body);
    res.json(deduction);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const runDeductions = async (req, res) => {
  try {
    const result = await deductionService.processSalaryDeductions();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createDeduction,
  getDeductions,
  updateDeduction,
  runDeductions,
};
