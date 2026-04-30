const applicationService = require('../services/applicationService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');

/**
 * Submit new membership application
 * @route   POST /api/applications
 * @access  Public
 */
const submitApplication = asyncHandler(async (req, res) => {
  const { name, email, phone, nationalId, type } = req.body;

  if (!name || !email || !phone || !nationalId || !type) {
    throw new ValidationError('Name, email, phone, national ID, and application type are required');
  }

  const application = await applicationService.createApplication(req.body);
  return ResponseHandler.created(res, application, 'Application submitted successfully');
});

const getApplicationById = asyncHandler(async (req, res) => {
  const application = await applicationService.getApplicationById(req.params.id);

  if (!application) {
    throw new NotFoundError('Application not found');
  }

  return ResponseHandler.success(res, application, 'Application retrieved successfully', 200);
});

const updateApplication = asyncHandler(async (req, res) => {
  const { feePaid, paymentReference, paymentPhone, consentGiven } = req.body;

  if (
    feePaid === undefined &&
    paymentReference === undefined &&
    paymentPhone === undefined &&
    consentGiven === undefined
  ) {
    throw new ValidationError('At least one application field is required to update');
  }

  const application = await applicationService.updateApplication(req.params.id, req.body);

  if (!application) {
    throw new NotFoundError('Application not found');
  }

  return ResponseHandler.success(res, application, 'Application updated successfully', 200);
});

/**
 * Get all membership applications
 * @route   GET /api/applications
 * @access  Admin
 */
const getApplications = asyncHandler(async (req, res) => {
  const applications = await applicationService.getAllApplications();
  return ResponseHandler.success(res, applications, 'Applications retrieved successfully', 200);
});

/**
 * Approve membership application
 * @route   PUT /api/applications/:id/approve
 * @access  Admin
 */
const approveApplication = asyncHandler(async (req, res) => {
  if (!req.body.adminId) {
    throw new ValidationError('Admin ID is required for approval');
  }
  const member = await applicationService.approveApplication(req.params.id, req.body.adminId);
  return ResponseHandler.success(res, member, 'Application approved successfully', 200);
});

/**
 * Reject membership application
 * @route   PUT /api/applications/:id/reject
 * @access  Admin
 */
const rejectApplication = asyncHandler(async (req, res) => {
  if (!req.body.reason) {
    throw new ValidationError('Rejection reason is required');
  }
  const application = await applicationService.rejectApplication(req.params.id, req.body.reason);
  return ResponseHandler.success(res, application, 'Application rejected successfully', 200);
});

module.exports = {
  submitApplication,
  getApplications,
  getApplicationById,
  updateApplication,
  approveApplication,
  rejectApplication,
};
