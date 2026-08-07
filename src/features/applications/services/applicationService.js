// services/applicationService.js
const db = require('../../../models');
const { getFirebaseDb, getFirebaseStorage } = require('../../../shared/config/firebase');

const parseDataUrl = (value) => {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(value || ''));
  if (!match) return null;
  const extension = match[1].split('/').pop().replace('jpeg', 'jpg');
  return {
    buffer: Buffer.from(match[2], 'base64'),
    contentType: match[1],
    extension,
  };
};

const uploadMemberDocument = async (memberNumber, label, dataUrl) => {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const objectPath = `members/${memberNumber}/documents/${label}.${parsed.extension}`;
  const file = getFirebaseStorage().bucket().file(objectPath);
  await file.save(parsed.buffer, {
    contentType: parsed.contentType,
    metadata: { cacheControl: 'private, max-age=3600' },
  });
  const [url] = await file.getSignedUrl({ action: 'read', expires: '2500-01-01' });
  return url;
};

const createApplication = async (data) => {
  return await db.MembershipApplication.create({
    name: data.name,
    email: data.email,
    phone: data.phone,
    nationalId: data.nationalId || data.identityNumber,
    identityType: data.identityType || 'national',
    identityNumber: data.identityNumber || data.nationalId,
    idDocument: data.idDocument || null,
    passportPhoto: data.passportPhoto || null,
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

const getApplications = async (queryOptions = {}) => {
  return await db.MembershipApplication.findAndCountAll(queryOptions);
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

const finalizePaidApplication = async ({
  applicationId,
  userId,
  paymentReference,
  paymentPhone,
  checkoutRequestId,
}) => {
  const application = await db.MembershipApplication.findByPk(applicationId);
  const user = await db.User.findByPk(userId);
  if (!application || !user) return null;

  if (String(application.email || '').trim().toLowerCase() !== String(user.email || '').trim().toLowerCase()) {
    const error = new Error('This application does not belong to the authenticated user');
    error.statusCode = 403;
    throw error;
  }

  await user.update({
    name: application.name || user.name,
    phone: application.phone || paymentPhone || user.phone,
    nationalId: application.nationalId || application.identityNumber || user.nationalId,
    kraPin: application.kraPin || user.kraPin,
    occupation: application.occupation || user.occupation,
    address: application.address || user.address,
    consentGiven: application.consentGiven ?? user.consentGiven,
    consentGivenAt: application.consentGivenAt || user.consentGivenAt || new Date(),
    role: 'MEMBER',
    isVerified: true,
  });

  let member = await db.Member.findOne({ where: { userId: user.id } });
  if (!member) {
    member = await db.Member.create({
      userId: user.id,
      memberNumber: `M-${Date.now()}-${String(user.id).slice(0, 6).toUpperCase()}`,
      type: application.type || 'NON_EMPLOYEE',
      nationalId: application.nationalId || application.identityNumber || user.nationalId || null,
      status: 'ACTIVE',
      dateJoined: new Date(),
      applicationId: application.id,
      paymentReference,
      isVerified: true,
    });
  } else {
    await member.update({
      type: application.type || member.type || 'NON_EMPLOYEE',
      nationalId: application.nationalId || application.identityNumber || member.nationalId,
      status: 'ACTIVE',
      dateJoined: member.dateJoined || new Date(),
      applicationId: application.id,
      paymentReference,
      isVerified: true,
    });
  }

  const references = [paymentReference, checkoutRequestId].filter(Boolean);
  let transaction = null;
  if (references.length) {
    transaction = await db.Transaction.findOne({
      where: {
        [db.Sequelize.Op.or]: references.flatMap((reference) => [
          { reference },
          { internalReference: reference },
        ]),
      },
    });
  }

  if (transaction) {
    await transaction.update({
      memberId: member.id,
      status: 'SUCCESS',
      reference: paymentReference || transaction.reference,
      type: 'MEMBERSHIP_FEE',
      paymentCategory: 'registration',
    });
    await member.update({ registrationTransactionId: transaction.id });
  }

  const [nationalIdUrl, passportUrl] = await Promise.all([
    uploadMemberDocument(member.memberNumber, 'national-id', application.idDocument),
    uploadMemberDocument(member.memberNumber, 'passport', application.passportPhoto),
  ]);

  if (nationalIdUrl || passportUrl) {
    await member.update({
      nationalIdUrl: nationalIdUrl || member.nationalIdUrl,
      passportUrl: passportUrl || member.passportUrl,
    });
  }

  if (!transaction && references.length) {
    const firestore = getFirebaseDb();
    for (const collectionName of ['Transactions', 'transactions']) {
      for (const field of ['reference', 'internalReference', 'checkout_request_id', 'checkoutRequestId']) {
        for (const reference of references) {
          const snapshot = await firestore.collection(collectionName)
            .where(field, '==', reference)
            .limit(1)
            .get();
          if (snapshot.empty) continue;

          const document = snapshot.docs[0];
          await document.ref.set({
            memberId: member.id,
            userId: user.id,
            applicationId: application.id,
            status: 'SUCCESS',
            paymentCategory: 'registration',
            updatedAt: new Date(),
          }, { merge: true });
          await member.update({ registrationTransactionId: document.id });
          transaction = { id: document.id };
          break;
        }
        if (transaction) break;
      }
      if (transaction) break;
    }
  }

  await Promise.all([
    db.SavingsAccount.findOne({ where: { memberId: member.id } })
      .then((record) => record || db.SavingsAccount.create({ memberId: member.id })),
    db.ShareAccount.findOne({ where: { memberId: member.id } })
      .then((record) => record || db.ShareAccount.create({ memberId: member.id })),
  ]);

  await application.update({
    feePaid: true,
    status: 'APPROVED',
    paymentReference,
    paymentPhone,
    paymentConfirmedAt: application.paymentConfirmedAt || new Date(),
    paymentVerifiedAt: application.paymentVerifiedAt || new Date(),
  });

  if (checkoutRequestId) {
    await getFirebaseDb().collection('registrations').doc(String(checkoutRequestId)).set({
      user_id: user.id,
      member_id: member.id,
      member_number: member.memberNumber,
      application_id: application.id,
      transaction_id: transaction?.id || null,
      membership_status: 'ACTIVE',
      onboarding_completed_at: new Date(),
      updated_at: new Date(),
    }, { merge: true });
  }

  return { application, user, member, transaction };
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
  finalizePaidApplication,
  approveApplication,
  rejectApplication,
};
