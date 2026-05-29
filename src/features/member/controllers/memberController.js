const { Op } = require('sequelize');
const db = require('../../../models');
const userService = require('../../users/services/userService');
const loanService = require('../../loans/services/loanService');
const shareService = require('../../shares/services/shareService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const { UserDTO, LoanDTO, TransactionDTO } = require('../../../shared/utils/dtos');
const logger = require('../../../shared/utils/logger');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;
const supabaseStorage = process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
  : null;
const PROFILE_PHOTO_BUCKET = process.env.SUPABASE_PROFILE_PHOTO_BUCKET || 'profile-photos';
const PROFILE_PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const PROFILE_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const DEFAULT_KCB_MPESA_BASE_URL = 'https://kcb-mpesa.simrion.workers.dev';
const LOCAL_KCB_MPESA_BASE_URL = 'https://kcb-mpesa.simrion.workers.dev';
const DEFAULT_KCB_PAYBILL_NUMBER = '522522';

const getKcbMpesaBaseUrl = () => {
  if (process.env.KCB_MPESA_BASE_URL) {
    return process.env.KCB_MPESA_BASE_URL;
  }
  return process.env.NODE_ENV === 'production'
    ? DEFAULT_KCB_MPESA_BASE_URL
    : LOCAL_KCB_MPESA_BASE_URL;
};

const findMemberByUserId = async (userId) => {
  return db.Member.findOne({ where: { userId } });
};

const ensureMemberByUser = async (user) => {
  let member = await findMemberByUserId(user.id);
  if (!member) {
    member = await db.Member.create({
      userId: user.id,
      memberNumber: `M-${Date.now()}`,
      nationalId: user.nationalId || null,
      type: 'NON_EMPLOYEE',
      isVerified: true,
    });
  }

  const savings = await db.SavingsAccount.findOne({ where: { memberId: member.id } });
  if (!savings) {
    await db.SavingsAccount.create({ memberId: member.id });
  }

  const shares = await db.ShareAccount.findOne({ where: { memberId: member.id } });
  if (!shares) {
    await db.ShareAccount.create({ memberId: member.id });
  }

  return member;
};

const buildTransactionDescription = (transaction) => {
  const pieces = [transaction.paymentCategory || transaction.type];
  if (transaction.method) {
    pieces.push(`via ${transaction.method}`);
  }
  if (transaction.reference) {
    pieces.push(`ref: ${transaction.reference}`);
  }
  return pieces.join(' | ');
};

const formatShareAccount = (share) => {
  const totalInvested = Number((share.shares || 0) * (share.shareValue || 0));
  return {
    id: share.id,
    memberId: share.memberId,
    shares: share.shares,
    shareValue: share.shareValue,
    totalInvested,
    purchaseDate: share.createdAt,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
};

const KCB_PROMPT_TYPES = {
  register: { endpoint: '/register', category: 'registration', label: 'Registration fee', transactionType: 'MEMBERSHIP_FEE' },
  registration: { endpoint: '/register', category: 'registration', label: 'Registration fee', transactionType: 'MEMBERSHIP_FEE' },
  kcbmpesa: { endpoint: '/kcbmpesa', category: 'kcb_mpesa', label: 'KCB M-PESA prompt', transactionType: 'DEPOSIT' },
  stkpush: { endpoint: '/stkpush', category: 'stk_push', label: 'STK push', transactionType: 'DEPOSIT' },
  monthly: { endpoint: '/monthlycontributions', category: 'monthly_contribution', label: 'Monthly contribution', transactionType: 'DEPOSIT' },
  monthlycontributions: { endpoint: '/monthlycontributions', category: 'monthly_contribution', label: 'Monthly contribution', transactionType: 'DEPOSIT' },
  loan_repayment: { endpoint: '/loans_repayment', category: 'loan_repayment', label: 'Loan repayment', transactionType: 'LOAN_REPAYMENT' },
  loans_repayment: { endpoint: '/loans_repayment', category: 'loan_repayment', label: 'Loan repayment', transactionType: 'LOAN_REPAYMENT' },
  repayment: { endpoint: '/loans_repayment', category: 'loan_repayment', label: 'Loan repayment', transactionType: 'LOAN_REPAYMENT' },
  fines: { endpoint: '/fines', category: 'fine', label: 'Fine payment', transactionType: 'DEPOSIT' },
  fine: { endpoint: '/fines', category: 'fine', label: 'Fine payment', transactionType: 'DEPOSIT' },
  sharecapital: { endpoint: '/sharecapital', category: 'share_capital', label: 'Share capital', transactionType: 'DEPOSIT' },
  share_capital: { endpoint: '/sharecapital', category: 'share_capital', label: 'Share capital', transactionType: 'DEPOSIT' },
  wallet: { endpoint: '/wallet', category: 'wallet', label: 'Wallet top-up', transactionType: 'DEPOSIT' },
  savings: { endpoint: '/savings', category: 'savings', label: 'Savings deposit', transactionType: 'DEPOSIT' },
};

const getKcbPromptType = (type) => {
  const normalized = String(type || 'monthly')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return KCB_PROMPT_TYPES[normalized] || KCB_PROMPT_TYPES.monthly;
};

const getKcbRegistrationForTransaction = async (transaction) => {
  if (!supabase) return null;

  const refs = [
    transaction.reference,
    transaction.internalReference,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (!refs.length) return null;

  const clauses = refs.flatMap((ref) => [
    `merchant_request_id.eq.${ref}`,
    `checkout_request_id.eq.${ref}`,
    `request_id.eq.${ref}`,
  ]);

  const { data, error } = await supabase
    .from('registrations')
    .select('status, mpesa_receipt, transaction_reference, merchant_request_id, checkout_request_id, request_id')
    .or(clauses.join(','))
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('Failed to fetch KCB-MPESA registration', {
      module: 'member',
      transactionId: transaction.id,
      error: error.message,
    });
    return null;
  }

  return data;
};

const syncTransactionWithKcbRegistration = async (transaction) => {
  if (!transaction || String(transaction.status || '').toUpperCase() !== 'PENDING') {
    return { transaction, registration: null };
  }

  const registration = await getKcbRegistrationForTransaction(transaction);
  if (!registration) return { transaction, registration: null };

  const normalizedStatus = String(registration.status || '').toLowerCase();
  const receipt = registration.mpesa_receipt || registration.transaction_reference || null;

  if (normalizedStatus === 'paid') {
    await transaction.update({
      status: 'SUCCESS',
      reference: receipt || transaction.reference,
    });
  } else if (normalizedStatus === 'failed') {
    await transaction.update({ status: 'FAILED' });
  }

  return { transaction, registration };
};

const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.private(user), 'Profile retrieved successfully');
});

const parseProfilePhotoDataUrl = (dataUrl) => {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) {
    throw new ValidationError('Profile photo must be a PNG, JPG, JPEG, or WEBP image.');
  }

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = PROFILE_PHOTO_TYPES[mimeType];
  if (!extension) {
    throw new ValidationError('Profile photo must be a PNG, JPG, JPEG, or WEBP image.');
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > PROFILE_PHOTO_MAX_BYTES) {
    throw new ValidationError('Profile photo must be 1.5 MB or smaller.');
  }

  return { buffer, mimeType, extension };
};

const uploadProfilePhoto = asyncHandler(async (req, res) => {
  if (!supabaseStorage) {
    throw new ValidationError('Profile photo storage is not configured.');
  }

  const { buffer, mimeType, extension } = parseProfilePhotoDataUrl(req.body?.photo);
  const objectPath = `members/${req.user.id}/passport-photo-${Date.now()}.${extension}`;

  const { error: uploadError } = await supabaseStorage.storage
    .from(PROFILE_PHOTO_BUCKET)
    .upload(objectPath, buffer, {
      contentType: mimeType,
      cacheControl: '3600',
      upsert: true,
    });

  if (uploadError) {
    throw new ValidationError(`Profile photo upload failed: ${uploadError.message}`);
  }

  const { data } = supabaseStorage.storage
    .from(PROFILE_PHOTO_BUCKET)
    .getPublicUrl(objectPath);

  const updated = await userService.updateUser(req.user.id, {
    passportPhotoUrl: data.publicUrl,
  });

  return ResponseHandler.success(res, UserDTO.private(updated), 'Profile photo updated successfully', 200);
});

const updateProfile = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  if (body.nextOfKin) {
    body.nextOfKinName = body.nextOfKin.name ?? body.nextOfKinName;
    body.nextOfKinRelationship = body.nextOfKin.relationship ?? body.nextOfKinRelationship;
    body.nextOfKinPhone = body.nextOfKin.phone ?? body.nextOfKinPhone;
    delete body.nextOfKin;
  }
  const allowed = [
    'firstName',
    'lastName',
    'name',
    'email',
    'phone',
    'nationalId',
    'kraPin',
    'occupation',
    'address',
    'dateOfBirth',
    'gender',
    'employer',
    'monthlyIncome',
    'payrollNumber',
    'nextOfKinName',
    'nextOfKinRelationship',
    'nextOfKinPhone',
    'passportPhotoUrl',
    'consentGiven',
    'consentGivenAt',
  ];
  const safeBody = allowed.reduce((acc, field) => {
    if (body[field] !== undefined) acc[field] = body[field];
    return acc;
  }, {});
  const sensitiveFields = ['email'];
  const touchesSensitiveField = sensitiveFields.some((field) => (
    safeBody[field] !== undefined && String(safeBody[field] || '') !== String(req.user[field] || '')
  ));
  if (touchesSensitiveField) {
    if (!body.currentPassword) {
      throw new ValidationError('Current password is required for email updates');
    }
    const fullUser = await db.User.findByPk(req.user.id);
    const passwordMatches = fullUser?.password && await bcrypt.compare(body.currentPassword, fullUser.password);
    if (!passwordMatches) {
      throw new ForbiddenError('Current password confirmation failed');
    }
  }
  const updated = await userService.updateUser(req.user.id, safeBody);
  if (!updated) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.private(updated), 'Profile updated successfully', 200);
});

const getLoans = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No loans found', 200);
  }

  const loans = await db.Loan.findAll({
    where: { memberId: member.id },
    include: [db.Guarantor],
    order: [['createdAt', 'DESC']],
  });

  const formatted = loans.map((loan) => ({
    id: loan.id,
    memberId: loan.memberId,
    type: loan.type,
    principal: loan.amount,
    balance: loan.amount,
    status: loan.status,
    approvedAt: loan.updatedAt,
    createdAt: loan.createdAt,
    guarantors: loan.Guarantors || [],
  }));

  return ResponseHandler.success(res, formatted, 'Member loans retrieved successfully', 200);
});

const applyForLoan = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  if (!req.body.amount || !req.body.type) {
    throw new ValidationError('Loan amount and type are required');
  }

  const loan = await loanService.createLoan({
    ...req.body,
    memberId: member.id,
    status: 'PENDING',
  });

  return ResponseHandler.created(res, LoanDTO.basic(loan, req.user), 'Loan application submitted successfully');
});

const cancelLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }

  if (loan.memberId !== member.id) {
    throw new ForbiddenError('You do not own this loan');
  }

  if (loan.status !== 'PENDING' && loan.status !== 'APPROVED') {
    throw new ValidationError('Loan cannot be cancelled at this stage');
  }

  const updated = await loanService.updateLoanStatus(loan.id, 'REJECTED');
  return ResponseHandler.success(res, updated, 'Loan cancelled successfully', 200);
});

const getShares = asyncHandler(async (req, res) => {
  const shares = await shareService.getShareAccountsForUser(req.user);
  const formatted = shares.map(formatShareAccount);
  return ResponseHandler.success(res, formatted, 'Share accounts retrieved successfully', 200);
});

const buyShares = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const { shares, amount } = req.body;
  if (shares === undefined && amount === undefined) {
    throw new ValidationError('Shares or amount is required');
  }

  const updatedShareAccount = await db.sequelize.transaction(async (transaction) => {
    const shareAccount = await db.ShareAccount.findOne({
      where: { memberId: member.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!shareAccount) {
      throw new NotFoundError('Share account not found');
    }

    const shareCount = shares !== undefined ? Number(shares) : Number(amount) / Number(shareAccount.shareValue || 1);
    if (isNaN(shareCount) || shareCount <= 0) {
      throw new ValidationError('Invalid share quantity or amount');
    }

    await shareAccount.update({ shares: Number(shareAccount.shares || 0) + shareCount }, { transaction });
    return shareAccount;
  });

  return ResponseHandler.success(res, formatShareAccount(updatedShareAccount), 'Shares purchased successfully', 200);
});

const getTransactions = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No transactions found', 200);
  }

  const where = { memberId: member.id };
  if (req.query.type) where.type = req.query.type;

  const transactions = await db.Transaction.findAll({ where, order: [['createdAt', 'DESC']] });
  await Promise.all(
    transactions
      .filter((transaction) => (
        String(transaction.status || '').toUpperCase() === 'PENDING'
        && transaction.method === 'MPESA'
        && (transaction.paymentCategory || transaction.kcbEndpoint)
      ))
      .map((transaction) => syncTransactionWithKcbRegistration(transaction))
  );

  const formatted = transactions.map((transaction) => ({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    internalReference: transaction.internalReference,
    promptChannel: transaction.promptChannel,
  }));

  return ResponseHandler.success(res, formatted, 'Transactions retrieved successfully', 200);
});

const getGuarantees = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No guarantees found', 200);
  }

  const guarantees = await db.Guarantor.findAll({
    where: { memberId: member.id },
    include: [
      { model: db.Loan, attributes: ['id', 'type', 'amount', 'status'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  const formatted = guarantees.map((guarantee) => ({
    id: guarantee.id,
    loanId: guarantee.loanId,
    amount: guarantee.amount,
    createdAt: guarantee.createdAt,
    loan: guarantee.Loan ? {
      id: guarantee.Loan.id,
      type: guarantee.Loan.type,
      amount: guarantee.Loan.amount,
      status: guarantee.Loan.status,
    } : null,
  }));

  return ResponseHandler.success(res, formatted, 'Guarantees retrieved successfully', 200);
});

const repayLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Repayment amount is required');
  }

  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  if (loan.memberId !== member.id) {
    throw new ForbiddenError('You do not own this loan');
  }
  if (!['ACTIVE', 'APPROVED'].includes(loan.status)) {
    throw new ValidationError('Loan is not eligible for repayment');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    loanId: loan.id,
    type: 'LOAN_REPAYMENT',
    amount,
    method: req.body.method || 'MANUAL',
    status: 'SUCCESS',
    reference: req.body.reference || `REPAY-${Date.now()}`
  });

  return ResponseHandler.created(res, TransactionDTO.basic({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
  }, 'Loan repayment recorded successfully'));  
});

const depositSavings = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Deposit amount is required');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    type: 'DEPOSIT',
    amount,
    method: req.body.method || 'MANUAL',
    status: 'SUCCESS',
    reference: req.body.reference || `DEP-${Date.now()}`
  });

  return ResponseHandler.created(res, TransactionDTO.basic({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
  }, 'Savings deposit recorded successfully'));
   
});

const initiateContribution = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Contribution amount is required');
  }

  const phone = req.body?.phone || req.user.phone;
  const paymentMode = String(req.body?.paymentMode || 'STK').toUpperCase();
  const contributionType = req.body?.contributionType || 'monthly';
  const promptType = getKcbPromptType(contributionType);
  const reference = `CONTRIB-${Date.now()}`;
  const memberNumber = member.memberNumber || reference;

  if (paymentMode === 'STK' && !phone) {
    throw new ValidationError('Phone number is required for STK push');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    type: promptType.transactionType,
    amount,
    method: 'MPESA',
    status: 'PENDING',
    reference,
    description: promptType.label,
    paymentCategory: promptType.category,
    kcbEndpoint: promptType.endpoint,
    internalReference: reference,
    promptChannel: paymentMode,
  });

  if (paymentMode === 'PAYBILL') {
    return ResponseHandler.created(res, {
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      status: transaction.status,
      method: transaction.method,
      reference: transaction.reference,
      description: transaction.description,
      paymentCategory: transaction.paymentCategory,
      kcbEndpoint: transaction.kcbEndpoint,
      internalReference: transaction.internalReference,
      promptChannel: transaction.promptChannel,
      paybill: {
        businessNumber: process.env.KCB_PAYBILL_NUMBER || process.env.MPESA_PAYBILL_NUMBER || DEFAULT_KCB_PAYBILL_NUMBER,
        accountNumber: memberNumber,
        amount,
        steps: [
          'Open M-PESA on your phone or SIM toolkit.',
          'Select Lipa na M-PESA.',
          'Select Pay Bill.',
          'Enter the business number shown here.',
          'Enter the account number shown here.',
          'Enter the amount and confirm with your PIN.',
          'Keep the MPESA confirmation message for your records.',
        ],
      },
    }, 'Contribution recorded. Complete payment using Paybill.');
  }

  const workerBaseUrl = getKcbMpesaBaseUrl();
  if (!workerBaseUrl) {
    await transaction.update({ status: 'FAILED' });
    throw new ValidationError('STK push is not configured. Set KCB_MPESA_BASE_URL on the backend or use Paybill.');
  }

  const endpoint = promptType.endpoint;
  const workerUrl = `${workerBaseUrl.replace(/\/$/, '')}${endpoint}`;
  logger.info('Sending KCB-MPESA STK request', {
    module: 'member',
    workerUrl,
    phone,
    amount: Math.round(amount),
    contributionType,
  });

  const workerRes = await fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      amount: Math.round(amount),
      invoiceNumber: memberNumber,
      member_number: memberNumber,
      internal_reference: reference,
      payment_category: promptType.category,
      kcb_endpoint: endpoint,
      prompt_channel: 'STK',
      name: req.user.name || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
      reference,
    }),
  });

  const workerText = await workerRes.text();
  let workerPayload = null;
  try {
    workerPayload = workerText ? JSON.parse(workerText) : null;
  } catch {
    workerPayload = { raw: workerText };
  }

  if (!workerRes.ok) {
    await transaction.update({ status: 'FAILED' });
    const workerMessage = workerPayload?.error || workerPayload?.message || workerPayload?.raw || 'KCB-MPESA STK push failed';
    throw new ValidationError(`KCB-MPESA STK push failed (${workerRes.status}): ${workerMessage}`);
  }

  const mpesaRequestReference = workerPayload?.merchantRequestId || workerPayload?.checkoutRequestId || null;
  if (!mpesaRequestReference) {
    await transaction.update({ status: 'FAILED' });
    throw new ValidationError(workerPayload?.message || 'KCB-MPESA accepted the request but did not return a request reference. STK push was not confirmed.');
  }

  await transaction.update({
    reference: mpesaRequestReference,
  });

  return ResponseHandler.created(res, {
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    status: transaction.status,
    method: transaction.method,
    reference: mpesaRequestReference,
    internalReference: reference,
    mpesaReference: mpesaRequestReference,
    description: transaction.description,
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    promptChannel: transaction.promptChannel,
    kcbMpesa: workerPayload,
  }, workerPayload?.message || workerPayload?.customerMessage || 'STK push sent. Check your phone and enter your M-PESA PIN.');
});

const checkContributionStatus = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);
  const transaction = await db.Transaction.findOne({
    where: {
      id: req.params.transactionId,
      memberId: member.id,
    },
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  if (!supabase || !transaction.reference) {
    return ResponseHandler.success(res, {
      id: transaction.id,
      status: transaction.status,
      reference: transaction.reference,
      mpesaReference: transaction.reference,
      paymentCategory: transaction.paymentCategory,
      kcbEndpoint: transaction.kcbEndpoint,
      internalReference: transaction.internalReference,
      promptChannel: transaction.promptChannel,
    }, 'Contribution status retrieved');
  }

  const { registration: data } = await syncTransactionWithKcbRegistration(transaction);

  const registrationStatus = String(data?.status || '').toLowerCase();
  const isPaid = registrationStatus === 'paid';
  const isFailed = registrationStatus === 'failed';
  const receipt = data?.mpesa_receipt || data?.transaction_reference || null;

  return ResponseHandler.success(res, {
    id: transaction.id,
    status: isPaid ? 'SUCCESS' : isFailed ? 'FAILED' : transaction.status,
    reference: receipt || transaction.reference,
    mpesaReference: receipt || transaction.reference,
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    internalReference: transaction.internalReference,
    promptChannel: transaction.promptChannel,
    checkoutRequestId: data?.checkout_request_id || null,
    merchantRequestId: data?.merchant_request_id || null,
  }, 'Contribution status retrieved');
});

const emailReport = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const reportType = req.body?.reportType || 'portfolio';
  const durationMonths = Number(req.body?.duration) || 0;
  const member = await findMemberByUserId(req.user.id);
  const dateFilter = durationMonths > 0 ? { createdAt: { [Op.gte]: new Date(new Date().setMonth(new Date().getMonth() - durationMonths)) } } : {};
  const transactions = member
    ? await db.Transaction.findAll({ where: { memberId: member.id, ...dateFilter }, order: [['createdAt', 'DESC']], limit: reportType === 'transactions' ? 100 : 20 })
    : [];
  const loans = member
    ? await db.Loan.findAll({ where: { memberId: member.id, ...dateFilter }, order: [['createdAt', 'DESC']] })
    : [];
  const shares = await shareService.getShareAccountsForUser(req.user);

  const successfulTransactions = transactions.filter((transaction) => ['SUCCESS', 'PAID', 'COMPLETED'].includes(String(transaction.status || '').toUpperCase()));
  const getCategory = (transaction) => String(
    transaction.paymentCategory ||
    transaction.kcbEndpoint ||
    transaction.description ||
    transaction.type ||
    ''
  ).toLowerCase();
  const categoryTotal = (tokens) => successfulTransactions.reduce((sum, transaction) => {
    const category = getCategory(transaction);
    return tokens.some((token) => category.includes(token))
      ? sum + Number(transaction.amount || 0)
      : sum;
  }, 0);
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const paidShareCapital = categoryTotal(['share_capital', 'sharecapital', 'share capital']);
  const shareAccountCapital = shares.reduce((sum, share) => sum + Number((share.shares || 0) * (share.shareValue || 0)), 0);
  const shareCapital = Math.max(paidShareCapital, shareAccountCapital);
  const savingsTotal = categoryTotal(['savings']);
  const outstandingLoans = loans.reduce((sum, loan) => sum + Number(loan.amount || 0), 0);
  const transactionTotal = successfulTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const formatMoney = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const transactionRows = transactions.map((transaction) => `
    <tr>
      <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(transaction.createdAt ? new Date(transaction.createdAt).toLocaleDateString() : '-')}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(transaction.type)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(transaction.paymentCategory || transaction.description || '-')}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(transaction.reference || '-')}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">KSh ${formatMoney(transaction.amount)}</td>
      <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${escapeHtml(transaction.status || '-')}</td>
    </tr>
  `).join('');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"Ayedos SACCO" <${process.env.SMTP_USER}>`,
    to: user.email,
    subject: `AYEDOS SACCO ${reportType} report`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2>AYEDOS SACCO ${reportType} report</h2>
        <p>Hello ${user.name || 'Member'},</p>
        <p>Your requested report summary is below.</p>
        <ul>
          <li><strong>Share capital:</strong> KSh ${formatMoney(shareCapital)}</li>
          <li><strong>Savings:</strong> KSh ${formatMoney(savingsTotal)}</li>
          <li><strong>Outstanding loans:</strong> KSh ${formatMoney(outstandingLoans)}</li>
          <li><strong>Successful transaction total:</strong> KSh ${formatMoney(transactionTotal)}</li>
          <li><strong>Loans:</strong> ${loans.length}</li>
          <li><strong>Transactions reviewed:</strong> ${transactions.length}</li>
        </ul>
        ${reportType === 'transactions' ? `
          <h3>Transaction statement</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
              <tr style="background: #f8fafc;">
                <th style="padding: 8px; text-align: left;">Date</th>
                <th style="padding: 8px; text-align: left;">Type</th>
                <th style="padding: 8px; text-align: left;">Prompt</th>
                <th style="padding: 8px; text-align: left;">Reference</th>
                <th style="padding: 8px; text-align: right;">Amount</th>
                <th style="padding: 8px; text-align: left;">Status</th>
              </tr>
            </thead>
            <tbody>${transactionRows || '<tr><td colspan="6" style="padding: 8px;">No transactions found.</td></tr>'}</tbody>
          </table>
        ` : ''}
        <p>Generated at ${new Date().toISOString()}.</p>
      </div>
    `
  });

  return ResponseHandler.success(res, null, 'Report sent to your email', 200);
});

module.exports = {
  getProfile,
  uploadProfilePhoto,
  updateProfile,
  getLoans,
  applyForLoan,
  cancelLoan,
  repayLoan,
  depositSavings,
  initiateContribution,
  checkContributionStatus,
  getShares,
  buyShares,
  getTransactions,
  getGuarantees,
  emailReport,
};
