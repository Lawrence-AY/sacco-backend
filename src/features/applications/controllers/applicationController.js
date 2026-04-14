const applicationService = require('../services/applicationService');

const submitApplication = async (req, res) => {
  try {
    const application = await applicationService.createApplication(req.body);
    res.status(201).json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getApplications = async (req, res) => {
  try {
    const applications = await applicationService.getAllApplications();
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const approveApplication = async (req, res) => {
  try {
    const member = await applicationService.approveApplication(req.params.id, req.body.adminId);
    res.status(200).json(member);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const rejectApplication = async (req, res) => {
  try {
    const application = await applicationService.rejectApplication(req.params.id, req.body.reason);
    res.json(application);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  submitApplication,
  getApplications,
  approveApplication,
  rejectApplication,
};
