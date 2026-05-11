const db = require('../../../models');
const { Op } = require('sequelize');
const userService = require('../../users/services/userService');
const applicationService = require('../../applications/services/applicationService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError, NotFoundError } = require('../../../shared/utils/errors');

const getAllUsers = asyncHandler(async (req, res) => {
  const users = await userService.getAllUsers();
  return ResponseHandler.success(res, users, 'Users retrieved successfully', 200);
});

const getUserById = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.params.userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, user, 'User retrieved successfully', 200);
});

const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!role) {
    throw new ValidationError('Role is required');
  }

  const updatedUser = await userService.updateUser(req.params.userId, { role });
  if (!updatedUser) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, updatedUser, 'User role updated successfully', 200);
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const { active } = req.body;
  if (active === undefined) {
    throw new ValidationError('Active status is required');
  }

  const updatedUser = await userService.updateUser(req.params.userId, { isVerified: Boolean(active) });
  if (!updatedUser) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, updatedUser, 'User status updated successfully', 200);
});

const getAllApplications = asyncHandler(async (req, res) => {
  const applications = await applicationService.getAllApplications();
  const filtered = req.query.status
    ? applications.filter((application) => application.status === req.query.status)
    : applications;
  const formatted = filtered.map((application) => ({
    id: application.id,
    applicantName: application.name,
    applicantEmail: application.email,
    status: application.status,
    submittedAt: application.createdAt,
    feePaid: application.feePaid,
    paymentVerifiedAt: application.paymentVerifiedAt,
    rejectedReason: application.rejectedReason,
  }));

  return ResponseHandler.success(res, formatted, 'Applications retrieved successfully', 200);
});

const reviewApplication = asyncHandler(async (req, res) => {
  const { status, notes } = req.body;
  if (!status) {
    throw new ValidationError('Review status is required');
  }

  if (status !== 'APPROVED' && status !== 'REJECTED') {
    throw new ValidationError('Status must be APPROVED or REJECTED');
  }

  if (status === 'APPROVED') {
    const result = await applicationService.approveApplication(req.params.applicationId, req.user.id);
    return ResponseHandler.success(res, result, 'Application approved successfully', 200);
  }

  const result = await applicationService.rejectApplication(req.params.applicationId, notes || 'No reason provided');
  return ResponseHandler.success(res, result, 'Application rejected successfully', 200);
});

const getSystemStats = asyncHandler(async (req, res) => {
  const totalMembers = await db.User.count({ where: { role: 'MEMBER' } });
  const pendingApplications = await db.MembershipApplication.count({ where: { status: { [Op.in]: ['PENDING_PAYMENT', 'PENDING_APPROVAL'] } } });
  const activeLoans = await db.Loan.count({ where: { status: 'ACTIVE' } });
  const totalSharesValueResult = await db.ShareAccount.findAll({ attributes: ['shares', 'shareValue'] });
  const totalShares = totalSharesValueResult.reduce((sum, account) => sum + (account.shares * account.shareValue), 0);
  const deposits = await db.Transaction.sum('amount', { where: { type: 'DEPOSIT', status: 'SUCCESS' } }) || 0;
  const withdrawals = await db.Transaction.sum('amount', { where: { type: 'WITHDRAWAL', status: 'SUCCESS' } }) || 0;
  const loansDisbursed = await db.Transaction.sum('amount', { where: { type: 'LOAN_DISBURSEMENT', status: 'SUCCESS' } }) || 0;
  const dividends = await db.Dividend.sum('amount') || 0;

  return ResponseHandler.success(res, {
    totalMembers,
    pendingApplications,
    activeLoans,
    totalShares,
    deposits,
    withdrawals,
    loansDisbursed,
    dividends,
  }, 'System stats retrieved successfully', 200);
});

module.exports = {
  getAllUsers,
  getUserById,
  updateUserRole,
  updateUserStatus,
  getAllApplications,
  reviewApplication,
  getSystemStats,
};
