const applicationService = require('../services/applicationService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError } = require('../../../shared/utils/errors');

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ... (Other functions like submitApplication, getApplications remain the same)

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