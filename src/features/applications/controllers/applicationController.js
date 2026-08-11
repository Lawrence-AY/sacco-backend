const applicationService = require('../services/applicationService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');
const { validateRequired, isValidEmail, isValidPhone, validatePagination } = require('../../../shared/utils/validation');
const { sanitizeModel, sanitizeModels } = require('../../../shared/utils/dtos');
const logger = require('../../../shared/utils/logger');
const { getFirebaseDb } = require('../../../shared/config/firebase');
const db = require('../../../models');

const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'completed', 'success', 'successful']);
const FAILED_PAYMENT_STATUSES = new Set(['failed', 'cancelled', 'canceled']);

const normalizePaymentStatus = (status) => {
  const normalized = String(status || 'pending').toLowerCase();
  if (SUCCESSFUL_PAYMENT_STATUSES.has(normalized)) return 'paid';
  if (FAILED_PAYMENT_STATUSES.has(normalized)) return 'failed';
  return 'pending';
};

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '').replace(/^0/, '254');

const normalizeApplicationType = (type, occupation) => {
  const normalizedType = String(type || '').trim().toUpperCase();
  if (normalizedType === 'EMPLOYEE' || String(occupation || '').trim().toLowerCase() === 'employed') {
    return 'EMPLOYEE';
  }
  return 'NON_EMPLOYEE';
};

const normalizeIdentityType = (identityType) => {
  const normalized = String(identityType || 'national').trim().toLowerCase();
  if (normalized === 'passport') return 'passport';
  if (['drivers_license', 'driver_license', 'driverlicense', 'driverslicense'].includes(normalized)) {
    return 'drivers_license';
  }
  return 'national';
};

const findRegistration = async (fieldValues) => {
  const registrations = getFirebaseDb().collection('registrations');

  for (const [field, rawValue] of fieldValues) {
    const value = String(rawValue || '').trim();
    if (!value) continue;

    const snapshot = await registrations.where(field, '==', value).limit(1).get();
    if (!snapshot.empty) {
      const document = snapshot.docs[0];
      return { id: document.id, ...document.data() };
    }
  }

  return null;
};

const findRegistrationByCheckoutId = (checkoutRequestId) => findRegistration([
  ['checkout_request_id', checkoutRequestId],
  ['checkoutRequestId', checkoutRequestId],
  ['merchant_request_id', checkoutRequestId],
  ['merchantRequestId', checkoutRequestId],
  ['request_id', checkoutRequestId],
]);

const findRegistrationByReceipt = (receipt) => findRegistration([
  ['mpesa_receipt', receipt],
  ['mpesaReceipt', receipt],
  ['transaction_reference', receipt],
  ['transactionReference', receipt],
]);

const asDate = (value) => {
  if (!value) return null;
  const date = value?.toDate?.() || new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const findLinkedTransaction = async (registration, checkoutRequestId) => {
  const firestore = getFirebaseDb();
  const collectionNames = ['Transactions', 'transactions'];
  const transactionId = registration?.transaction_id || registration?.transactionId;

  for (const collectionName of collectionNames) {
    const collection = firestore.collection(collectionName);
    if (transactionId) {
      const document = await collection.doc(String(transactionId)).get();
      if (document.exists) return { id: document.id, ref: document.ref, ...document.data() };
    }

    for (const field of ['reference', 'checkout_request_id', 'checkoutRequestId']) {
      const snapshot = await collection.where(field, '==', checkoutRequestId).limit(2).get();
      if (snapshot.size === 1) {
        const document = snapshot.docs[0];
        return { id: document.id, ref: document.ref, ...document.data() };
      }
    }
  }

  // Older pending records did not store transaction_id. Recover only when one
  // transaction unambiguously matches the payment amount and initiation time.
  const registrationDate = asDate(registration?.created_at || registration?.createdAt);
  const registrationAmount = Number(registration?.amount);
  if (!registrationDate || !Number.isFinite(registrationAmount)) return null;

  const candidates = [];
  for (const collectionName of collectionNames) {
    const snapshot = await firestore.collection(collectionName)
      .where('amount', '==', registrationAmount)
      .get();
    snapshot.forEach((document) => {
      const data = document.data();
      const createdAt = asDate(data.createdAt || data.created_at);
      if (
        createdAt
        && Math.abs(createdAt.getTime() - registrationDate.getTime()) <= 15_000
      ) {
        candidates.push({ id: document.id, ref: document.ref, ...data });
      }
    });
  }

  return candidates.length === 1 ? candidates[0] : null;
};

const syncRegistrationPaymentStatus = async (registration, checkoutRequestId) => {
  if (!registration) return null;
  const currentStatus = normalizePaymentStatus(registration.status);
  const currentReceipt = registration.mpesa_receipt
    || registration.mpesaReceipt
    || registration.transaction_reference
    || registration.transactionReference
    || null;
  if (currentStatus !== 'pending' && (currentStatus === 'failed' || currentReceipt)) {
    return registration;
  }

  const transaction = await findLinkedTransaction(registration, checkoutRequestId);
  if (!transaction) return registration;

  const transactionStatus = normalizePaymentStatus(transaction.status);
  if (transactionStatus === 'pending') return registration;

  const receipt = transactionStatus === 'paid'
    && transaction.reference
    && transaction.reference !== checkoutRequestId
      ? transaction.reference
      : null;
  const updates = {
    transaction_id: transaction.id,
    status: transactionStatus,
    mpesa_receipt: receipt,
    updated_at: new Date(),
  };
  await getFirebaseDb().collection('registrations').doc(String(registration.id)).set(updates, { merge: true });

  logger.info('Synchronized STK registration with Firebase transaction', {
    module: 'applications',
    checkoutRequestId,
    registrationId: registration.id,
    transactionId: transaction.id,
    status: transactionStatus,
    hasReceipt: Boolean(receipt),
  });

  return { ...registration, ...updates };
};

const submitApplication = asyncHandler(async (req, res) => {
  const authenticatedEmail = String(req.user?.email || '').trim().toLowerCase();
  const identityNumber = req.body.identityNumber || req.body.nationalId || '';
  const identityType = normalizeIdentityType(req.body.identityType);

  const payload = {
    name: req.body.name,
    email: authenticatedEmail,
    phone: req.body.phone,
    nationalId: identityNumber,
    identityType,
    identityNumber,
    idDocument: req.body.idDocument || null,
    passportPhoto: req.body.passportPhoto || null,
    kraPin: req.body.kraPin || null,
    type: normalizeApplicationType(req.body.type, req.body.occupation),
    occupation: req.body.occupation,
    address: req.body.address || null,
    poBox: req.body.poBox || null,
    county: req.body.county || null,
    subCounty: req.body.subCounty || null,
    consentGiven: Boolean(req.body.consentGiven),
  };

  validateRequired(payload, ['name', 'email', 'phone', 'identityNumber', 'type']);

  if (!isValidEmail(payload.email)) {
    throw new ValidationError('A valid email is required');
  }

  if (!isValidPhone(payload.phone)) {
    throw new ValidationError('A valid phone number is required');
  }

  let application = await db.MembershipApplication.findOne({
    where: {
      email: authenticatedEmail,
      status: { [db.Sequelize.Op.in]: ['PENDING_PAYMENT', 'PENDING_APPROVAL'] },
    },
    order: [['createdAt', 'DESC']],
  });

  if (application) {
    await application.update(payload);
  } else {
    application = await applicationService.createApplication(payload);
  }

  return ResponseHandler.created(
    res,
    sanitizeModel(application, {
      fields: ['id', 'name', 'email', 'phone', 'status', 'feePaid', 'createdAt', 'updatedAt'],
    }),
    'Application submitted successfully'
  );
});

const getApplicationById = asyncHandler(async (req, res) => {
  const application = await applicationService.getApplicationById(req.params.id);

  if (!application) {
    throw new NotFoundError('Application not found');
  }

  return ResponseHandler.success(
    res,
    sanitizeModel(application, {
      fields: [
        'id',
        'name',
        'email',
        'phone',
        'status',
        'feePaid',
        'nationalId',
        'occupation',
        'address',
        'consentGiven',
        'paymentVerifiedAt',
        'createdAt',
        'updatedAt',
      ],
    }),
    'Application retrieved successfully',
    200
  );
});

const updateApplication = asyncHandler(async (req, res) => {
  const { feePaid, paymentReference, paymentPhone, consentGiven, occupation, address } = req.body;
  const allowedFields = [feePaid, paymentReference, paymentPhone, consentGiven, occupation, address];

  if (allowedFields.every((value) => typeof value === 'undefined')) {
    throw new ValidationError('At least one application field is required to update');
  }

  if (paymentPhone && !isValidPhone(paymentPhone)) {
    throw new ValidationError('A valid payment phone number is required');
  }

  if (paymentReference && typeof paymentReference !== 'string') {
    throw new ValidationError('Payment reference must be a string');
  }

  const application = await applicationService.updateApplication(req.params.id, req.body);

  if (!application) {
    throw new NotFoundError('Application not found');
  }

  return ResponseHandler.success(
    res,
    sanitizeModel(application, {
      fields: ['id', 'name', 'email', 'phone', 'status', 'feePaid', 'paymentReference', 'paymentPhone', 'createdAt', 'updatedAt'],
    }),
    'Application updated successfully',
    200
  );
});

/**
 * Get all membership applications
 * @route   GET /api/applications
 * @access  Admin
 */
const getApplications = asyncHandler(async (req, res) => {
  const { status, page = 1, limit = 10 } = req.query;
  const { page: pageNum, limit: limitNum } = validatePagination(page, limit);
  const offset = (pageNum - 1) * limitNum;

  const where = {};
  if (status) where.status = status;

  const { count, rows } = await applicationService.getApplications({
    where,
    offset,
    limit: limitNum,
    order: [['createdAt', 'DESC']],
  });

  return ResponseHandler.paginated(
    res,
    sanitizeModels(rows, {
      fields: ['id', 'name', 'email', 'phone', 'status', 'feePaid', 'createdAt', 'updatedAt'],
    }),
    {
      total: count,
      page: pageNum,
      limit: limitNum,
      pages: Math.ceil(count / limitNum),
    },
    'Applications retrieved successfully'
  );
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


const checkStkStatus = asyncHandler(async (req, res) => {
  const checkoutRequestId = String(req.query.checkoutRequestId || '').trim();
  if (!checkoutRequestId) {
    throw new ValidationError('checkoutRequestId is required');
  }

  let registration;
  try {
    registration = await findRegistrationByCheckoutId(checkoutRequestId);
    registration = await syncRegistrationPaymentStatus(registration, checkoutRequestId);
  } catch (error) {
    logger.error('Failed to fetch STK payment status from Firebase', {
      module: 'applications',
      checkoutRequestId,
      requestId: req.id,
      error: error.message,
      stack: error.stack,
    });
    throw new Error('Failed to fetch payment status');
  }

  if (!registration) {
    logger.info('STK payment is not recorded yet', {
      module: 'applications',
      checkoutRequestId,
      requestId: req.id,
    });
    return ResponseHandler.success(res, { status: 'pending', mpesaReceipt: null }, 'STK status retrieved');
  }

  const status = normalizePaymentStatus(registration.status);
  const mpesaReceipt = registration.mpesa_receipt
    || registration.mpesaReceipt
    || registration.transaction_reference
    || registration.transactionReference
    || null;

  logger.info('STK payment status retrieved', {
    module: 'applications',
    checkoutRequestId,
    registrationId: registration.id,
    status,
    hasReceipt: Boolean(mpesaReceipt),
    requestId: req.id,
  });

  return ResponseHandler.success(res, {
    status,
    mpesaReceipt,
  }, 'STK status retrieved');
});

const verifyPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  let { paymentReference, paymentPhone, phone, checkoutRequestId } = req.body;

  logger.info('Payment verification requested', { module: 'applications', applicationId: id });

  let registration = null;
  if (checkoutRequestId) {
    registration = await findRegistrationByCheckoutId(checkoutRequestId);
    registration = await syncRegistrationPaymentStatus(registration, checkoutRequestId);
  }

  let paymentReferenceValue = paymentReference?.trim()
    || registration?.mpesa_receipt
    || registration?.mpesaReceipt
    || registration?.transaction_reference
    || registration?.transactionReference
    || null;
  let paymentPhoneValue = paymentPhone?.trim()
    || phone?.trim()
    || String(registration?.phone || registration?.phone_number || registration?.phoneNumber || '').trim()
    || null;

  if (!paymentReferenceValue || !paymentPhoneValue) {
    return ResponseHandler.validationError(res, {
      paymentReference: !paymentReferenceValue ? 'Payment reference is required' : undefined,
      paymentPhone: !paymentPhoneValue ? 'Payment phone is required' : undefined,
    }, 'Payment verification details are required');
  }

  if (!isValidPhone(paymentPhoneValue)) {
    return ResponseHandler.validationError(res, { paymentPhone: 'A valid payment phone number is required' }, 'Invalid payment phone');
  }

  if (!registration) {
    registration = await findRegistrationByReceipt(paymentReferenceValue);
  }

  const registrationPhone = registration?.phone
    || registration?.phone_number
    || registration?.phoneNumber;
  const phoneMatches = !registrationPhone
    || normalizePhone(registrationPhone) === normalizePhone(paymentPhoneValue);

  if (!registration || normalizePaymentStatus(registration.status) !== 'paid' || !phoneMatches) {
    logger.warn('Payment verification did not find a matching successful Firebase registration', {
      module: 'applications',
      applicationId: id,
      checkoutRequestId: checkoutRequestId || null,
      paymentReference: paymentReferenceValue,
      registrationId: registration?.id || null,
      registrationStatus: registration?.status || null,
      phoneMatches,
      requestId: req.id,
    });
    return ResponseHandler.error(res, 'Payment not confirmed or record not found.', 400);
  }

  const finalized = await applicationService.finalizePaidApplication({
    applicationId: id,
    userId: req.user.id,
    paymentReference: paymentReferenceValue,
    paymentPhone: paymentPhoneValue,
    checkoutRequestId,
  });

  if (!finalized) throw new NotFoundError('Application or authenticated user not found');

  return ResponseHandler.success(
    res,
    {
      application: sanitizeModel(finalized.application, {
        fields: ['id', 'name', 'email', 'phone', 'status', 'feePaid', 'paymentReference', 'paymentPhone', 'paymentVerifiedAt', 'createdAt', 'updatedAt'],
      }),
      member: sanitizeModel(finalized.member, {
        fields: ['id', 'userId', 'memberNumber', 'type', 'nationalId', 'status', 'dateJoined', 'applicationId', 'paymentReference', 'registrationTransactionId', 'isVerified'],
      }),
    },
    'Payment verified and member registration completed'
  );
});

module.exports = {
  submitApplication,
  getApplications,
  getApplicationById,
  updateApplication,
  approveApplication,
  rejectApplication,
  checkStkStatus,
  verifyPayment,
};
