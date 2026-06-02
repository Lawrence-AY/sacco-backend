const applicationService = require('../services/applicationService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');
const { validateRequired, isValidEmail, isValidPhone, validatePagination } = require('../../../shared/utils/validation');
const { sanitizeModel, sanitizeModels } = require('../../../shared/utils/dtos');
const logger = require('../../../shared/utils/logger');

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const submitApplication = asyncHandler(async (req, res) => {
  const identityNumber = req.body.identityNumber || req.body.nationalId || '';
  const identityType = req.body.identityType || 'national';

  const payload = {
    name: req.body.name,
    email: req.body.email,
    phone: req.body.phone,
    nationalId: identityNumber,
    identityType,
    identityNumber,
    idDocument: req.body.idDocument || null,
    type: req.body.type,
    occupation: req.body.occupation,
    address: req.body.address,
    consentGiven: Boolean(req.body.consentGiven),
  };

  validateRequired(payload, ['name', 'email', 'phone', 'identityNumber', 'type']);

  if (!isValidEmail(payload.email)) {
    throw new ValidationError('A valid email is required');
  }

  if (!isValidPhone(payload.phone)) {
    throw new ValidationError('A valid phone number is required');
  }

  const application = await applicationService.createApplication(payload);
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
  const { checkoutRequestId } = req.query;
  if (!checkoutRequestId) {
    throw new ValidationError('checkoutRequestId is required');
  }
  const { data, error } = await supabase
    .from('registrations')
    .select('status, mpesa_receipt')
    .eq('checkout_request_id', checkoutRequestId)
    .maybeSingle();

  if (error) {
    logger.error('Failed to fetch payment status', { module: 'applications', error: error.message });
    throw new Error('Failed to fetch payment status');
  }
  
  if (!data) {
    return ResponseHandler.success(res, { status: 'pending', mpesaReceipt: null }, 'STK status retrieved');
  }
  
  return ResponseHandler.success(res, { 
    status: data.status, 
    mpesaReceipt: data.mpesa_receipt || null 
  }, 'STK status retrieved');
});

const verifyPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  let { paymentReference, paymentPhone, phone, checkoutRequestId } = req.body;

  logger.info('Payment verification requested', { module: 'applications', applicationId: id });

  // 1. Resolve missing details using checkoutRequestId if needed
  if ((!paymentReference || !phone) && checkoutRequestId) {
    const { data: reg } = await supabase
      .from('registrations')
      .select('mpesa_receipt, phone, status')
      .eq('checkout_request_id', checkoutRequestId)
      .maybeSingle();
    
    if (reg && reg.status === 'paid') {
      paymentReference = reg.mpesa_receipt;
      phone = reg.phone;
    }
  }

  // 2. Guard Clause
  let paymentReferenceValue = paymentReference?.trim() || null;
  let paymentPhoneValue = paymentPhone?.trim() || phone?.trim() || null;

  if ((!paymentReferenceValue || !paymentPhoneValue) && checkoutRequestId) {
    const { data: reg } = await supabase
      .from('registrations')
      .select('mpesa_receipt, phone, status')
      .eq('checkout_request_id', checkoutRequestId)
      .maybeSingle();

    if (reg && reg.status === 'paid') {
      paymentReferenceValue = paymentReferenceValue || reg.mpesa_receipt;
      paymentPhoneValue = paymentPhoneValue || reg.phone;
    }
  }

  if (!paymentReferenceValue || !paymentPhoneValue) {
    return ResponseHandler.validationError(res, {
      paymentReference: !paymentReferenceValue ? 'Payment reference is required' : undefined,
      paymentPhone: !paymentPhoneValue ? 'Payment phone is required' : undefined,
    }, 'Payment verification details are required');
  }

  if (!isValidPhone(paymentPhoneValue)) {
    return ResponseHandler.validationError(res, { paymentPhone: 'A valid payment phone number is required' }, 'Invalid payment phone');
  }

  // 3. Verify final status in Supabase
  let { data: registration } = await supabase
    .from('registrations')
    .select('mpesa_receipt, phone, status')
    .eq('mpesa_receipt', paymentReferenceValue)
    .eq('phone', paymentPhoneValue)
    .maybeSingle();

  if (!registration) {
    const { data } = await supabase
      .from('registrations')
      .select('transaction_reference, phone, status')
      .eq('transaction_reference', paymentReferenceValue)
      .eq('phone', paymentPhoneValue)
      .maybeSingle();
    registration = data;
  }

  if (!registration || !['paid', 'completed', 'success'].includes(String(registration.status || '').toLowerCase())) {
    return ResponseHandler.error(res, 'Payment not confirmed or record not found.', 400);
  }

  const application = await applicationService.updateApplication(id, {
    feePaid: true,
    paymentReference: paymentReferenceValue,
    paymentPhone: paymentPhoneValue,
  });

  if (!application) throw new NotFoundError('Application not found');

  return ResponseHandler.success(
    res,
    sanitizeModel(application, {
      fields: ['id', 'name', 'email', 'phone', 'status', 'feePaid', 'paymentReference', 'paymentPhone', 'paymentVerifiedAt', 'createdAt', 'updatedAt'],
    }),
    'Payment verified successfully'
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
