// src/features/applications/controllers/applications.controller.js
const crypto = require('crypto');
const MembershipApplication = require('../../../models/membershipApplication.model');
const User = require('../../../models/user.model');
const asyncHandler = require('../../../shared/utils/asyncHandler');

// Define custom error classes locally
class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
    this.name = 'BadRequest';
  }
}

class Unauthorized extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 401;
    this.name = 'Unauthorized';
  }
}

class NotFound extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 404;
    this.name = 'NotFound';
  }
}

class Conflict extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 409;
    this.name = 'Conflict';
  }
}

// Create a new membership application
exports.createApplication = asyncHandler(async (req, res) => {
  const {
    name,
    firstName,
    surname,
    nationalId,
    kraPin,
    phone,
    email,
    type,
    occupation,
    address,
    consentGiven,
  } = req.body; // Removed idDocumentName, passportPhotoName

  const applicationName = name?.trim() || [firstName, surname].filter(Boolean).join(' ').trim();

  // Validate required fields
  if (!applicationName || !phone || !email) {
    throw new BadRequest('Name, phone, and email are required');
  }

  // Check if email already registered as a user
  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    throw new Conflict('Email already registered');
  }

  // Check if application already exists with this email that is not rejected
  const existingApplication = await MembershipApplication.findOne({
    where: { email },
  });
  if (existingApplication && existingApplication.status !== 'REJECTED') {
    throw new Conflict('Application already exists for this email');
  }

  // Create new application with available fields
  const applicationData = {
    name: applicationName,
    phone,
    email,
    status: 'PENDING_PAYMENT',
    feePaid: false,
  };

  // Add optional fields if provided
  if (nationalId) applicationData.nationalId = nationalId;
  if (kraPin) applicationData.kraPin = kraPin;
  if (occupation) applicationData.occupation = occupation;
  if (type) applicationData.type = type;
  else if (occupation) {
    applicationData.type = occupation === 'Employed' ? 'EMPLOYEE' : 'NON_EMPLOYEE';
  }
  if (address) applicationData.address = address;
  if (consentGiven) {
    applicationData.consentGiven = consentGiven;
    applicationData.consentGivenAt = new Date();
  }

  const application = await MembershipApplication.create(applicationData);

  res.status(201).json({
    success: true,
    message: 'Membership application created successfully',
    data: application,
  });
});

// Get application by ID
exports.getApplication = asyncHandler(async (req, res) => {
  const { applicationId } = req.params;

  const application = await MembershipApplication.findByPk(applicationId);
  if (!application) {
    throw new NotFound('Application not found');
  }

  res.json({
    success: true,
    data: application,
  });
});

// Verify payment for an application
exports.verifyPayment = asyncHandler(async (req, res) => {
  const { applicationId } = req.params;
  const { paymentReference, paymentPhone, paymentMethod } = req.body;

  if (!paymentReference || !paymentPhone) {
    throw new BadRequest('Payment reference and phone are required');
  }

  const application = await MembershipApplication.findByPk(applicationId);
  if (!application) {
    throw new NotFound('Application not found');
  }

  if (application.status !== 'PENDING_PAYMENT') {
    throw new BadRequest('Application is not in PENDING_PAYMENT status');
  }

  // For now, accept any reference as verified
  application.paymentReference = paymentReference.toUpperCase();
  application.paymentPhone = paymentPhone;
  application.feePaid = true;
  application.paymentVerifiedAt = new Date();
  application.status = 'PENDING_APPROVAL';
  await application.save();

  res.json({
    success: true,
    message: 'Payment verified successfully',
    data: application,
  });
});

// Submit application for approval after payment verification
exports.submitApplication = asyncHandler(async (req, res) => {
  const { applicationId } = req.params;

  const application = await MembershipApplication.findByPk(applicationId);
  if (!application) {
    throw new NotFound('Application not found');
  }

  if (application.status !== 'PENDING_PAYMENT') {
    throw new BadRequest('Application must be in PENDING_PAYMENT status to submit');
  }

  if (!application.feePaid) {
    throw new BadRequest('Payment must be verified before submission');
  }

  application.status = 'PENDING_APPROVAL';
  await application.save();

  res.json({
    success: true,
    message: 'Application submitted for approval',
    data: application,
  });
});

// Get application status
exports.getApplicationStatus = asyncHandler(async (req, res) => {
  const { applicationId } = req.params;

  const application = await MembershipApplication.findByPk(applicationId);
  if (!application) {
    throw new NotFound('Application not found');
  }

  res.json({
    success: true,
    data: {
      id: application.id,
      status: application.status,
      feePaid: application.feePaid,
      paymentVerifiedAt: application.paymentVerifiedAt,
      rejectedReason: application.rejectedReason,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    },
  });
});

// Approve an application (Admin only)
exports.approveApplication = asyncHandler(async (req, res) => {
  const { applicationId } = req.params;

  if (req.user?.role !== 'ADMIN') {
    throw new Unauthorized('Only admins can approve applications');
  }

  const application = await MembershipApplication.findByPk(applicationId);
  if (!application) {
    throw new NotFound('Application not found');
  }

  if (application.status !== 'PENDING_APPROVAL') {
    throw new BadRequest('Application is not pending approval');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const activationExpiry = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours

  application.status = 'APPROVED';
  application.approvedById = req.user.id;
  application.activationToken = token;
  application.activationTokenExpiresAt = activationExpiry;
  await application.save();

  const activationUrl = `${process.env.FRONTEND_URL || 'http://localhost:5174'}/set-password?token=${token}`;

  // TODO: Send activation email

  res.json({
    success: true,
    message: 'Application approved successfully',
    data: {
      ...application.toJSON(),
      activationUrl,
    },
  });
});

// Reject an application (Admin only)
exports.rejectApplication = asyncHandler(async (req, res) => {
  const { applicationId } = req.params;
  const { reason } = req.body;

  if (req.user?.role !== 'ADMIN') {
    throw new Unauthorized('Only admins can reject applications');
  }

  const application = await MembershipApplication.findByPk(applicationId);
  if (!application) {
    throw new NotFound('Application not found');
  }

  if (application.status !== 'PENDING_APPROVAL') {
    throw new BadRequest('Application is not pending approval');
  }

  application.status = 'REJECTED';
  application.rejectedReason = reason || 'No reason provided';
  application.approvedById = req.user.id;
  await application.save();

  // TODO: Send rejection email

  res.json({
    success: true,
    message: 'Application rejected successfully',
    data: application,
  });
});

// Get all applications (Admin only)
exports.getApplications = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'ADMIN') {
    throw new Unauthorized('Only admins can view all applications');
  }

  const { status, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  const where = {};
  if (status) where.status = status;

  const { count, rows } = await MembershipApplication.findAndCountAll({
    where,
    offset,
    limit,
    order: [['createdAt', 'DESC']],
  });

  res.json({
    success: true,
    data: rows,
    pagination: {
      total: count,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(count / limit),
    },
  });
});