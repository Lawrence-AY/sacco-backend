const prisma = require('../../../shared/config/prisma');

const createApplication = async (data) => {
  return await prisma.membershipApplication.create({
    data: {
      name: data.name,
      email: data.email,
      phone: data.phone,
      nationalId: data.nationalId,
      type: data.type,
      consentGiven: data.consentGiven ?? false,
      feePaid: data.feePaid ?? false,
    },
  });
};

const getAllApplications = async () => {
  return await prisma.membershipApplication.findMany({
    orderBy: { createdAt: 'desc' },
  });
};

const approveApplication = async (applicationId, adminId) => {
  const application = await prisma.membershipApplication.findUnique({
    where: { id: applicationId },
  });

  if (!application) {
    throw new Error('Application not found');
  }

  if (!application.feePaid) {
    throw new Error('Membership fee must be paid before approval');
  }

  if (!application.consentGiven) {
    throw new Error('Consent must be given before approval');
  }

  const user = await prisma.user.create({
    data: {
      name: application.name,
      email: application.email,
      phone: application.phone,
      password: '',
      role: 'MEMBER',
      consentGiven: application.consentGiven,
      consentGivenAt: application.consentGivenAt ?? new Date(),
    },
  });

  const member = await prisma.member.create({
    data: {
      userId: user.id,
      memberNumber: `M-${Date.now()}`,
      type: application.type,
      nationalId: application.nationalId,
      isVerified: true,
    },
  });

  await prisma.savingsAccount.create({
    data: {
      memberId: member.id,
      balance: 0,
    },
  });

  await prisma.shareAccount.create({
    data: {
      memberId: member.id,
      shares: 0,
      shareValue: 100,
    },
  });

  await prisma.membershipApplication.update({
    where: { id: applicationId },
    data: {
      status: 'APPROVED',
      approvedById: adminId,
    },
  });

  return member;
};

const rejectApplication = async (applicationId, reason) => {
  return await prisma.membershipApplication.update({
    where: { id: applicationId },
    data: {
      status: 'REJECTED',
      rejectedReason: reason,
    },
  });
};

module.exports = {
  createApplication,
  getAllApplications,
  approveApplication,
  rejectApplication,
};
