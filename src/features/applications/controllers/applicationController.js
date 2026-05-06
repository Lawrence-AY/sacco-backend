const applicationService = require('../services/applicationService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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
    console.error('Supabase error:', error);
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
  let { paymentReference, phone, checkoutRequestId } = req.body;

  console.log(`[Verify] Checking App ID: ${id}`);

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
  if (!paymentReference || !phone) {
    return res.status(400).json({
      success: false,
      message: 'Payment reference and phone are required for verification.'
    });
  }

  // 3. Verify final status in Supabase
  const { data: registration } = await supabase
    .from('registrations')
    .select('*')
    .eq('mpesa_receipt', paymentReference)
    .eq('phone', phone)
    .maybeSingle();

  if (!registration || registration.status !== 'paid') {
    return res.status(400).json({
      success: false,
      message: 'Payment not confirmed or record not found.'
    });
  }

  // 4. Update the actual application in your DB
  const application = await applicationService.updateApplication(id, {
    feePaid: true,
    paymentReference,
    paymentPhone: phone,
  });

  if (!application) throw new NotFoundError('Application not found');

  return ResponseHandler.success(res, application, 'Payment verified successfully');
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