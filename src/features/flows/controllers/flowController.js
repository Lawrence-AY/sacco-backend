const flowService = require('../services/flowService');

const getAllFlows = async (req, res) => {
  try {
    const flows = await flowService.getAllFlows();
    res.json(flows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getFlowById = async (req, res) => {
  try {
    const flow = await flowService.getFlowById(req.params.id);
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    res.json(flow);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const createFlow = async (req, res) => {
  try {
    const flow = await flowService.createFlow(req.body);
    res.status(201).json(flow);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateFlow = async (req, res) => {
  try {
    const flow = await flowService.updateFlow(req.params.id, req.body);
    if (!flow) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    res.json(flow);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const deleteFlow = async (req, res) => {
  try {
    const result = await flowService.deleteFlow(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Flow not found' });
    }
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getAllFlows,
  getFlowById,
  createFlow,
  updateFlow,
  deleteFlow,
};