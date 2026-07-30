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
const { getFirebaseDb, getFirebaseStorage } = require('../../../shared/config/firebase');
const PROFILE_PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const PROFILE_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const DEFAULT_KCB_PAYBILL_NUMBER = '522522';
const MINIMUM_LOAN_SHARE_CAPITAL = 25000;
const LOAN_ELIGIBILITY_MESSAGE = 'You are not yet eligible to apply for a loan. Please complete the minimum required share capital purchase before submitting a loan application.';

const getKcbMpesaBaseUrl = () => process.env.MPESA_URL?.trim().replace(/\/+$/, '') || null;

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
  const refs = [
    transaction.reference,
    transaction.internalReference,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (!refs.length) return null;

  const matches = [];
  for (const field of ['transaction_reference', 'merchant_request_id', 'checkout_request_id', 'request_id']) {
    for (const ref of refs) {
      const snapshot = await getFirebaseDb().collection('registrations').where(field, '==', ref).limit(1).get();
      snapshot.forEach((document) => matches.push({ id: document.id, ...document.data() }));
    }
  }

  matches.sort((left, right) => {
    const leftDate = left.updated_at?.toDate?.() || new Date(left.updated_at || 0);
    const rightDate = right.updated_at?.toDate?.() || new Date(right.updated_at || 0);
    return rightDate - leftDate;
  });
  return matches[0] || null;
};

const asDate = (value) => {
  if (!value) return null;
  const date = value?.toDate?.() || new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getProviderTransaction = async (transaction) => {
  const firestore = getFirebaseDb();
  // Cloudflare owns the uppercase collection; the lowercase collection is
  // the backend ledger and must never be treated as provider confirmation.
  const collections = ['Transactions'];

  if (transaction.providerTransactionId) {
    for (const name of collections) {
      const document = await firestore.collection(name).doc(String(transaction.providerTransactionId)).get();
      if (document.exists) return { id: document.id, ...document.data() };
    }
  }

  const lookups = [
    ['reference', transaction.checkoutRequestId],
    ['internalReference', transaction.providerInternalReference],
    ['reference', transaction.reference],
    ['internalReference', transaction.internalReference],
  ].filter(([, value]) => Boolean(value));

  for (const name of collections) {
    for (const [field, value] of lookups) {
      const snapshot = await firestore.collection(name).where(field, '==', value).limit(2).get();
      if (snapshot.size === 1) {
        const document = snapshot.docs[0];
        return { id: document.id, ...document.data() };
      }
    }
  }

  // Legacy contribution records lack provider IDs. Recover only an
  // unambiguous provider transaction created at the same time and amount.
  const createdAt = asDate(transaction.createdAt);
  const amount = Number(transaction.amount);
  if (!createdAt || !Number.isFinite(amount)) return null;

  const candidates = [];
  for (const name of collections) {
    const snapshot = await firestore.collection(name).where('amount', '==', amount).get();
    snapshot.forEach((document) => {
      const data = document.data();
      const providerCreatedAt = asDate(data.createdAt || data.created_at);
      if (
        providerCreatedAt
        && Math.abs(providerCreatedAt.getTime() - createdAt.getTime()) <= 15_000
      ) {
        candidates.push({ id: document.id, ...data });
      }
    });
  }
  return candidates.length === 1 ? candidates[0] : null;
};

const syncTransactionWithKcbRegistration = async (transaction) => {
  if (!transaction || String(transaction.status || '').toUpperCase() !== 'PENDING') {
    return { transaction, registration: null };
  }

  // Provider callbacks can be delayed, and users may reopen the dashboard
  // after polling stopped. Keep same-day pending transactions recoverable.
  const ageMs = Date.now() - new Date(transaction.createdAt).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    return { transaction, registration: null };
  }

  let registration = null;
  try {
    const providerTransaction = await getProviderTransaction(transaction);
    if (providerTransaction) {
      const providerStatus = String(providerTransaction.status || '').toUpperCase();
      const receipt = providerStatus === 'SUCCESS' ? providerTransaction.reference || null : null;

      if (providerStatus === 'SUCCESS' || providerStatus === 'FAILED') {
        await transaction.update({
          status: providerStatus,
          reference: receipt || transaction.reference,
          providerTransactionId: providerTransaction.id,
          providerInternalReference: providerTransaction.internalReference
            || transaction.providerInternalReference,
        });
      }

      return {
        transaction,
        registration: {
          status: providerStatus === 'SUCCESS'
            ? 'paid'
            : providerStatus === 'FAILED'
              ? 'failed'
              : 'pending',
          mpesa_receipt: receipt,
          transaction_reference: receipt,
          checkout_request_id: transaction.checkoutRequestId || null,
          merchant_request_id: transaction.merchantRequestId || null,
        },
      };
    }

    registration = await getKcbRegistrationForTransaction(transaction);
  } catch (error) {
    // Supabase may be down — gracefully skip sync
    logger.warn('KCB-MPESA registration sync skipped (Supabase unavailable)', {
      module: 'member',
      transactionId: transaction.id,
      error: String(error?.message || error).slice(0, 200),
    });
    return { transaction, registration: null };
  }

  if (!registration) return { transaction, registration: null };

  const normalizedStatus = String(registration.status || '').toLowerCase();
  const receipt = registration.mpesa_receipt || registration.transaction_reference || null;

  if (['paid', 'completed', 'success'].includes(normalizedStatus)) {
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
  const { buffer, mimeType, extension } = parseProfilePhotoDataUrl(req.body?.photo);
  const objectPath = `members/${req.user.id}/passport-photo-${Date.now()}.${extension}`;
  const file = getFirebaseStorage().bucket().file(objectPath);
  await file.save(buffer, {
    contentType: mimeType,
    metadata: { cacheControl: 'public, max-age=3600' },
  });
  const [publicUrl] = await file.getSignedUrl({ action: 'read', expires: '2500-01-01' });

  const updated = await userService.updateUser(req.user.id, {
    passportPhotoUrl: publicUrl,
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

const getMemberExitBalances = async (memberId) => {
  const [savingsAccount, shareAccount, successfulTransactions] = await Promise.all([
    db.SavingsAccount.findOne({ where: { memberId } }),
    db.ShareAccount.findOne({ where: { memberId } }),
    db.Transaction.findAll({
      where: {
        memberId,
        status: 'SUCCESS',
      },
    }),
  ]);

  const categoryTotal = (tokens) => successfulTransactions.reduce((sum, transaction) => {
    const category = String(
      transaction.paymentCategory ||
      transaction.kcbEndpoint ||
      transaction.description ||
      transaction.type ||
      ''
    ).toLowerCase();
    return tokens.some((token) => category.includes(token))
      ? sum + Number(transaction.amount || 0)
      : sum;
  }, 0);

  const savings = Math.max(Number(savingsAccount?.balance || 0), categoryTotal(['savings']));
  const shareAccountCapital = Number(shareAccount?.shares || 0) * Number(shareAccount?.shareValue || 0);
  const shareCapital = Math.max(
    shareAccountCapital,
    categoryTotal(['share_capital', 'sharecapital', 'share capital'])
  );
  const saccoFee = shareCapital * 0.01;

  return {
    savings,
    shareCapital,
    saccoFee,
    auctionAmount: Math.max(shareCapital - saccoFee, 0),
  };
};

const requestOptOut = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const existingRequest = await db.MemberExitRequest.findOne({
    where: {
      memberId: member.id,
      status: { [Op.in]: ['PENDING', 'APPROVED'] },
    },
    order: [['createdAt', 'DESC']],
  });

  if (existingRequest) {
    throw new ValidationError('You already have an active opt-out request under review.');
  }

  const balances = await getMemberExitBalances(member.id);
  const request = await db.MemberExitRequest.create({
    memberId: member.id,
    savingsWithdrawalAmount: balances.savings,
    shareCapitalAmount: balances.shareCapital,
    saccoFeeAmount: balances.saccoFee,
    auctionAmount: balances.auctionAmount,
    buyerMemberNumber: req.body.buyerMemberNumber || null,
    reason: req.body.reason || null,
    acknowledgedTerms: req.body.acknowledgedTerms,
    requestedAt: new Date(),
  });

  return ResponseHandler.success(res, {
    id: request.id,
    status: request.status,
    savingsWithdrawalAmount: request.savingsWithdrawalAmount,
    shareCapitalAmount: request.shareCapitalAmount,
    saccoFeeAmount: request.saccoFeeAmount,
    auctionAmount: request.auctionAmount,
    buyerMemberNumber: request.buyerMemberNumber,
    requestedAt: request.requestedAt,
  }, 'Opt-out request submitted successfully', 201);
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
  const balances = await getMemberExitBalances(member.id);

  if (balances.shareCapital < MINIMUM_LOAN_SHARE_CAPITAL) {
    throw new ForbiddenError(LOAN_ELIGIBILITY_MESSAGE);
  }

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

  if (promptType.category === 'loan_repayment') {
    const balances = await getMemberExitBalances(member.id);
    if (balances.shareCapital < MINIMUM_LOAN_SHARE_CAPITAL) {
      throw new ForbiddenError(LOAN_ELIGIBILITY_MESSAGE);
    }
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
    throw new ValidationError('STK push is not configured. Set MPESA_URL on the backend or use Paybill.');
  }

  const endpoint = promptType.endpoint;
  const workerUrl = `${workerBaseUrl}${endpoint}`;
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
    const isSystemBusy = String(workerMessage).toLowerCase().includes('busy') || String(workerMessage).toLowerCase().includes('system');
    const friendlyMessage = isSystemBusy
      ? 'M-PESA is currently busy. Please try Paybill as an alternative, or wait a few minutes and try STK Push again.'
      : `M-PESA payment failed: ${workerMessage}`;
    throw new ValidationError(friendlyMessage);
  }

  const mpesaRequestReference = workerPayload?.checkoutRequestId || workerPayload?.merchantRequestId || null;
  if (!mpesaRequestReference) {
    await transaction.update({ status: 'FAILED' });
    throw new ValidationError(workerPayload?.message || 'KCB-MPESA accepted the request but did not return a request reference. STK push was not confirmed.');
  }

  await transaction.update({
    reference: mpesaRequestReference,
    checkoutRequestId: workerPayload?.checkoutRequestId || null,
    merchantRequestId: workerPayload?.merchantRequestId || null,
    providerTransactionId: workerPayload?.transaction?.id || null,
    providerInternalReference: workerPayload?.transaction?.internalReference
      || workerPayload?.accountReference
      || null,
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

  if (!transaction.reference) {
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
  const isPaid = ['paid', 'completed', 'success'].includes(registrationStatus);
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
  requestOptOut,
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
