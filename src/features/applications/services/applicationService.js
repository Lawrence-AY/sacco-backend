// services/applicationService.js
const db = require('../../../models');

const createApplication = async (data) => {
  return await db.MembershipApplication.create({
    name: data.name,
    email: data.email,
    phone: data.phone,
    nationalId: data.nationalId,
    kraPin: data.kraPin,
    occupation: data.occupation ?? null,
    address: data.address ?? null,
    type: data.type,
    consentGiven: data.consentGiven ?? false,
    consentGivenAt: data.consentGiven ? new Date() : null,
    feePaid: data.feePaid ?? false,
    paymentReference: data.paymentReference ?? null,
    paymentPhone: data.paymentPhone ?? null,
    paymentConfirmedAt: data.feePaid ? new Date() : null,
  });
};

const getAllApplications = async () => {
  return await db.MembershipApplication.findAll({
    order: [['createdAt', 'DESC']],
  });
};

const getApplicationById = async (id) => {
  return await db.MembershipApplication.findByPk(id);
};

const updateApplication = async (id, data) => {
  const application = await db.MembershipApplication.findByPk(id);

  if (!application) {
    return null;
  }

  return await application.update({
    feePaid: data.feePaid ?? application.feePaid,
    consentGiven: data.consentGiven ?? application.consentGiven,
    consentGivenAt:
      data.consentGiven === true
        ? application.consentGivenAt ?? new Date()
        : application.consentGivenAt,
    paymentReference: data.paymentReference ?? application.paymentReference,
    paymentPhone: data.paymentPhone ?? application.paymentPhone,
    paymentConfirmedAt:
      data.feePaid === true
        ? application.paymentConfirmedAt ?? new Date()
        : application.paymentConfirmedAt,
    occupation: data.occupation ?? application.occupation,
    address: data.address ?? application.address,
    // Removed idDocumentName and passportPhotoName
  });
};

const approveApplication = async (applicationId, adminId) => {
  const application = await db.MembershipApplication.findByPk(applicationId);

  if (!application) {
    throw new Error('Application not found');
  }

  if (!application.feePaid) {
    throw new Error('Membership fee must be paid before approval');
  }

  if (!application.consentGiven) {
    throw new Error('Consent must be given before approval');
  }

  const user = await db.User.create({
    name: application.name,
    email: application.email,
    phone: application.phone,
    password: '',
    role: 'MEMBER',
    consentGiven: application.consentGiven,
    consentGivenAt: application.consentGivenAt ?? new Date(),
  });

  const member = await db.Member.create({
    userId: user.id,
    memberNumber: `M-${Date.now()}`,
    type: application.type,
    nationalId: application.nationalId,
    isVerified: true,
  });

  await db.SavingsAccount.create({
    memberId: member.id,
  });

  await db.ShareAccount.create({
    memberId: member.id,
  });

  await db.MembershipApplication.update({
    status: 'APPROVED',
    approvedById: adminId,
  }, { where: { id: applicationId } });

  return { user, member };
};

const rejectApplication = async (applicationId, reason) => {
  return await db.MembershipApplication.update({
    status: 'REJECTED',
    rejectedReason: reason,
  }, { where: { id: applicationId } });
};

module.exports = {
  createApplication,
  getAllApplications,
  getApplicationById,
  updateApplication,
  approveApplication,
  rejectApplication,
};