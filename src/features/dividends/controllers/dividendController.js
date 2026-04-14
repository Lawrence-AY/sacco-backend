const dividendService = require('../services/dividendService');

const getAllDividends = async (req, res) => {
  try {
    const dividends = await dividendService.getAllDividends();
    res.json(dividends);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getDividendById = async (req, res) => {
  try {
    const dividend = await dividendService.getDividendById(req.params.id);
    if (!dividend) {
      return res.status(404).json({ error: 'Dividend not found' });
    }
    res.json(dividend);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createDividend = async (req, res) => {
  try {
    const dividend = await dividendService.createDividend(req.body);
    res.status(201).json(dividend);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateDividend = async (req, res) => {
  try {
    const dividend = await dividendService.updateDividend(req.params.id, req.body);
    if (!dividend) {
      return res.status(404).json({ error: 'Dividend not found' });
    }
    res.json(dividend);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteDividend = async (req, res) => {
  try {
    const result = await dividendService.deleteDividend(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Dividend not found' });
    }
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getAllDividends,
  getDividendById,
  createDividend,
  updateDividend,
  deleteDividend,
};