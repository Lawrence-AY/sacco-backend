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
const notificationService = require('../../notifications/services/notificationService');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const { buildReportEmail, getBrandLogoAttachments } = require('../../../services/email/templates');
const { buildBrandedReportPdf } = require('../../../services/reports/pdfReport');
const { buildReportSections, formatMoney, reportNames } = require('../../../services/reports/reportTemplates');
const shareCapitalTransferService = require('../../shares/services/shareCapitalTransferService');
const memberNumberService = require('../services/memberNumberService');
const { formatEAT } = require('../../../shared/utils/eatDateTime');
const { getFirebaseDb, getFirebaseStorage } = require('../../../shared/config/firebase');
const PROFILE_PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const PROFILE_PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const KYC_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const KYC_DOCUMENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

const DEFAULT_KCB_PAYBILL_NUMBER = '522522';
const MINIMUM_LOAN_SHARE_CAPITAL = 25000;
const LOAN_ELIGIBILITY_MESSAGE = 'You are not yet eligible to apply for a loan. Please complete the minimum required share capital purchase before submitting a loan application.';
const SELF_GUARANTEE_MULTIPLIER = Number(process.env.SELF_GUARANTEE_SAVINGS_MULTIPLIER || 1);

const getKcbMpesaBaseUrl = () => process.env.MPESA_URL?.trim().replace(/\/+$/, '') || null;

const findMemberByUserId = async (userId) => {
  return db.Member.findOne({ where: { userId } });
};

const ensureMemberByUser = async (user) => {
  let member = await findMemberByUserId(user.id);
  if (!member) {
    member = await memberNumberService.createMember({
      userId: user.id,
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

const addScheduleMonths = (value, months) => {
  const date = new Date(value);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return date;
};

const getLoanRepaymentTotals = async (memberId) => {
  const repayments = await db.Transaction.findAll({
    where: {
      memberId,
      type: 'LOAN_REPAYMENT',
      status: 'SUCCESS',
      loanId: { [Op.ne]: null },
    },
    attributes: ['loanId', 'amount'],
  });

  return repayments.reduce((map, repayment) => {
    const loanId = String(repayment.loanId || '');
    if (!loanId) return map;
    map.set(loanId, (map.get(loanId) || 0) + Number(repayment.amount || 0));
    return map;
  }, new Map());
};

const findLoanForRepayment = async (memberId) => {
  const loans = await db.Loan.findAll({
    where: {
      memberId,
      status: { [Op.in]: ['APPROVED', 'ACTIVE'] },
    },
    order: [['createdAt', 'ASC']],
  });
  if (!loans.length) return null;

  const repaymentTotals = await getLoanRepaymentTotals(memberId);
  return loans.find((loan) => {
    const paid = repaymentTotals.get(String(loan.id)) || 0;
    return Number(loan.amount || 0) - paid > 0;
  }) || null;
};

const releaseCoveredGuarantors = async (loanId) => {
  const totalRepaid = await db.Transaction.sum('amount', {
    where: {
      loanId,
      type: 'LOAN_REPAYMENT',
      status: 'SUCCESS',
    },
  });
  const repaid = Number(totalRepaid || 0);
  const guarantors = await db.Guarantor.findAll({
    where: { loanId, status: 'ACCEPTED' },
    order: [['respondedAt', 'ASC']],
  });

  await Promise.all(guarantors
    .filter((guarantor) => repaid >= Number(guarantor.amount || 0))
    .map((guarantor) => guarantor.update({ status: 'RELEASED', releasedAt: new Date() })));
};

const applyLoanRepaymentLink = async (transaction) => {
  if (
    !transaction
    || String(transaction.type || '').toUpperCase() !== 'LOAN_REPAYMENT'
    || String(transaction.status || '').toUpperCase() !== 'SUCCESS'
  ) {
    return transaction;
  }

  let loanId = transaction.loanId;
  if (!loanId) {
    const loan = await findLoanForRepayment(transaction.memberId);
    if (!loan) {
      logger.warn('Successful loan repayment has no active loan to apply to', {
        module: 'member',
        transactionId: transaction.id,
        memberId: transaction.memberId,
      });
      return transaction;
    }

    await transaction.update({ loanId: loan.id });
    loanId = loan.id;
  }

  await releaseCoveredGuarantors(loanId);
  return transaction;
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
        if (providerStatus === 'SUCCESS') {
          await applyLoanRepaymentLink(transaction);
        }
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
    await applyLoanRepaymentLink(transaction);
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
  const member = await findMemberByUserId(req.user.id);
  return ResponseHandler.success(res, { ...UserDTO.private(user), nominees: member?.nominees || [] }, 'Profile retrieved successfully');
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

const parseKycDocumentDataUrl = (dataUrl) => {
  const match = /^data:(image\/(?:png|jpe?g)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
  if (!match) {
    throw new ValidationError('KYC document must be a PNG, JPG, JPEG, or PDF file.');
  }

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const extension = KYC_DOCUMENT_TYPES[mimeType];
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > KYC_DOCUMENT_MAX_BYTES) {
    throw new ValidationError('KYC document must be 5 MB or smaller.');
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

const uploadKycDocuments = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);
  const front = parseKycDocumentDataUrl(req.body?.front);
  const identityType = String(req.body?.identityType || 'national').toLowerCase();
  const isPassport = identityType === 'passport';
  const back = isPassport ? null : parseKycDocumentDataUrl(req.body?.back);
  const bucket = getFirebaseStorage().bucket();

  const saveDocument = async (side, parsed) => {
    const label = isPassport ? `passport-${side}` : `national-id-${side}`;
    const objectPath = `members/${member.memberNumber || member.id}/documents/${label}-${Date.now()}.${parsed.extension}`;
    const file = bucket.file(objectPath);
    await file.save(parsed.buffer, {
      contentType: parsed.mimeType,
      metadata: { cacheControl: 'private, max-age=3600' },
    });
    const [url] = await file.getSignedUrl({ action: 'read', expires: '2500-01-01' });
    return url;
  };

  const [frontUrl, backUrl] = await Promise.all([
    saveDocument('front', front),
    back ? saveDocument('back', back) : Promise.resolve(null),
  ]);

  await member.update({
    nationalIdUrl: isPassport ? member.nationalIdUrl : frontUrl,
    nationalIdBackUrl: isPassport ? member.nationalIdBackUrl : backUrl,
    passportUrl: isPassport ? frontUrl : member.passportUrl,
    passportBackUrl: member.passportBackUrl,
  });

  const updated = await userService.getUserById(req.user.id);
  return ResponseHandler.success(res, { ...UserDTO.private(updated), Member: member }, 'KYC documents updated successfully', 200);
});

const updateProfile = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  const nominees = body.nominees;
  delete body.nominees;
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
    'poBox',
    'county',
    'subCounty',
    'dateOfBirth',
    'gender',
    'employer',
    'monthlyIncome',
    'payrollNumber',
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
  const member = await findMemberByUserId(req.user.id);
  if (nominees !== undefined && member) await member.update({ nominees });
  return ResponseHandler.success(res, { ...UserDTO.private(updated), nominees: member?.nominees || [] }, 'Profile updated successfully', 200);
});

const transferShareCapital = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');
  const result = await shareCapitalTransferService.transfer({
    senderMemberId: member.id,
    recipientMemberNumber: req.body.recipientMemberNumber,
    amount: req.body.amount,
    optOut: req.body.optOut === true,
  });
  return ResponseHandler.success(res, result, 'Share capital transferred successfully', 201);
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
  const saccoFee = shareCapital * 0.05;

  return {
    savings,
    shareCapital,
    saccoFee,
    auctionAmount: Math.max(shareCapital - saccoFee, 0),
  };
};

const getAvailableSelfGuaranteeSavings = async (memberId) => {
  const balances = await getMemberExitBalances(memberId);
  const [activeGuarantees, activeSelfGuaranteedLoans] = await Promise.all([
    db.Guarantor.sum('amount', {
      where: {
        memberId,
        status: { [Op.in]: ['PENDING', 'ACCEPTED'] },
      },
    }),
    db.Loan.sum('selfGuaranteedAmount', {
      where: {
        memberId,
        selfGuaranteed: true,
        status: { [Op.in]: ['PENDING', 'PENDING_GUARANTORS', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE'] },
      },
    }),
  ]);

  const encumbered = Number(activeGuarantees || 0) + Number(activeSelfGuaranteedLoans || 0);
  return Math.max((Number(balances.savings || 0) * SELF_GUARANTEE_MULTIPLIER) - encumbered, 0);
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
    adminApproval: false,
    financeApproval: false,
    status: 'PENDING',
  });
  await notificationService.createOptOutReviewNotifications(request.id);

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
    include: [{
      model: db.Guarantor,
      include: [{
        model: db.Member,
        include: [{
          model: db.User,
          attributes: ['id', 'name', 'fullName', 'email', 'phone'],
        }],
      }],
    }],
    order: [['createdAt', 'DESC']],
  });
  const formatted = loans.map((loan) => ({
    id: loan.id,
    memberId: loan.memberId,
    type: loan.type,
    principal: loan.amount,
    principalBalance: Number(loan.principalBalance ?? loan.amount ?? 0),
    accruedInterest: Number(loan.accruedInterest || 0),
    balance: Number(loan.principalBalance ?? loan.amount ?? 0) + Number(loan.accruedInterest || 0),
    repaid: Math.max(Number(loan.amount || 0) - Number(loan.principalBalance ?? loan.amount ?? 0), 0),
    interestRate: Number(loan.interestRate || 0),
    duration: Number(loan.duration || 0),
    nextPaymentDueAt: loan.nextPaymentDueAt,
    lastInterestAccrualAt: loan.lastInterestAccrualAt,
    autoApproved: loan.type === 'EMERGENCY' && loan.status === 'APPROVED',
    auditTimestamp: loan.decidedAt,
    status: loan.status,
    approvedAt: loan.updatedAt,
    createdAt: loan.createdAt,
    selfGuaranteed: loan.selfGuaranteed,
    selfGuaranteedAmount: loan.selfGuaranteedAmount,
    guarantors: (loan.Guarantors || []).map((guarantor) => ({
      id: guarantor.id,
      memberId: guarantor.memberId,
      amount: guarantor.amount,
      status: guarantor.status,
      name: guarantor.Member?.User?.name || guarantor.Member?.User?.fullName || guarantor.Member?.memberNumber || null,
      memberName: guarantor.Member?.User?.name || guarantor.Member?.User?.fullName || null,
      memberNumber: guarantor.Member?.memberNumber || null,
      Member: guarantor.Member,
    })),
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

  const selfGuarantee = req.body.selfGuarantee === true;
  const requestedAmount = Number(req.body.amount || 0);
  const isEmergencyLoan = String(req.body.type || '').toUpperCase() === 'EMERGENCY';
  const guarantors = Array.isArray(req.body.guarantors) ? req.body.guarantors : [];
  if (selfGuarantee) {
    const requestedGuaranteeAmount = Number(req.body.selfGuaranteedAmount || requestedAmount);
    const availableSavings = await getAvailableSelfGuaranteeSavings(member.id);

    if (requestedGuaranteeAmount < requestedAmount) {
      throw new ValidationError('Self-guarantee amount must cover the requested loan amount');
    }

    if (requestedGuaranteeAmount > availableSavings) {
      throw new ValidationError(`Self-guarantee exceeds available savings. Available self-guarantee limit is KES ${availableSavings.toLocaleString()}.`);
    }
  }
  if (!selfGuarantee && !isEmergencyLoan && guarantors.length < 1) {
    throw new ValidationError('Select at least one guarantor, or use self-guarantee if your savings cover the loan.');
  }

  const result = await loanService.createLoan({
    ...req.body,
    memberId: member.id,
    status: 'PENDING',
    selfGuarantee,
    selfGuaranteedAmount: selfGuarantee ? Number(req.body.selfGuaranteedAmount || requestedAmount) : 0,
    guarantors: selfGuarantee || isEmergencyLoan ? [] : guarantors,
  });

  return ResponseHandler.created(res, {
    success: true,
    transactionId: result.transactionId,
    loanDetails: LoanDTO.basic(result.loan, req.user),
  }, result.autoApproved ? 'Emergency Loan Auto-Approved & Disbursed' : 'Loan application submitted successfully');
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

  const where = { memberId: member.id, status: { [Op.in]: ['SUCCESS', 'PAID', 'COMPLETED'] } };
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

  const visibleTransactions = transactions;

  const formatted = visibleTransactions.map((transaction) => ({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    createdAtEAT: formatEAT(transaction.createdAt),
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
    paymentCategory: transaction.paymentCategory,
    kcbEndpoint: transaction.kcbEndpoint,
    internalReference: transaction.internalReference,
    promptChannel: transaction.promptChannel,
  }));
  const transfers = (await shareCapitalTransferService.historyForMember(member.id))
    .filter((transfer) => String(transfer.status || '').toUpperCase() === 'SUCCESS');
  formatted.push(...transfers.map((transfer) => ({
    id: transfer.id,
    type: 'SHARE_CAPITAL_TRANSFER',
    amount: Number(transfer.grossAmount),
    netAmount: Number(transfer.netAmount),
    feeAmount: Number(transfer.feeAmount),
    direction: transfer.senderMemberId === member.id ? 'OUT' : 'IN',
    description: transfer.senderMemberId === member.id
      ? `Share capital transfer to ${transfer.recipient?.memberNumber}`
      : `Share capital transfer from ${transfer.sender?.memberNumber}`,
    createdAt: transfer.createdAt,
    createdAtEAT: formatEAT(transfer.createdAt),
    status: transfer.status,
    reference: transfer.reference,
    paymentCategory: 'share_capital_transfer',
    transferType: transfer.transferType,
  })));
  formatted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
    status: guarantee.status,
    createdAt: guarantee.createdAt,
    respondedAt: guarantee.respondedAt,
    releasedAt: guarantee.releasedAt,
    loan: guarantee.Loan ? {
      id: guarantee.Loan.id,
      type: guarantee.Loan.type,
      amount: guarantee.Loan.amount,
      status: guarantee.Loan.status,
    } : null,
  }));

  return ResponseHandler.success(res, formatted, 'Guarantees retrieved successfully', 200);
});

const searchGuarantors = asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) {
    return ResponseHandler.success(res, [], 'Enter at least 2 characters to search guarantors', 200);
  }

  const currentMember = await findMemberByUserId(req.user.id);
  const members = await db.Member.findAll({
    where: {
      id: { [Op.ne]: currentMember?.id || null },
      [Op.or]: [
        { memberNumber: { [Op.iLike]: `%${term}%` } },
        { '$User.name$': { [Op.iLike]: `%${term}%` } },
        { '$User.firstName$': { [Op.iLike]: `%${term}%` } },
        { '$User.lastName$': { [Op.iLike]: `%${term}%` } },
      ],
    },
    include: [{
      model: db.User,
      attributes: ['id', 'name', 'firstName', 'lastName'],
    }],
    limit: 10,
    order: [['memberNumber', 'ASC']],
  });

  const guaranteeCounts = await Promise.all(members.map(async (member) => {
    const [count, balances] = await Promise.all([
      db.Guarantor.count({
        where: {
          memberId: member.id,
          status: { [Op.in]: ['PENDING', 'ACCEPTED'] },
        },
      }),
      getMemberExitBalances(member.id),
    ]);
    return [member.id, { count, balances }];
  }));
  const countMap = new Map(guaranteeCounts);

  const results = members
    .filter((member) => {
      const balances = countMap.get(member.id)?.balances || {};
      return (
        (member.isVerified || String(member.status || '').toUpperCase() === 'ACTIVE')
        && Number(balances.shareCapital || 0) >= MINIMUM_LOAN_SHARE_CAPITAL
      );
    })
    .map((member) => {
      const user = member.User || {};
      const fullName = user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || member.memberNumber;
      const entry = countMap.get(member.id) || {};
      const activeGuarantees = entry.count || 0;
      return {
        memberId: member.id,
        memberNumber: member.memberNumber,
        name: fullName,
        status: activeGuarantees > 0 ? `${activeGuarantees} active guarantee${activeGuarantees === 1 ? '' : 's'}` : 'Available',
        activeGuarantees,
      };
    });

  return ResponseHandler.success(res, results, 'Guarantors retrieved successfully', 200);
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

  const result = await db.sequelize.transaction(async (dbTransaction) => {
    const loan = await db.Loan.findByPk(req.params.loanId, {
      transaction: dbTransaction,
      lock: dbTransaction.LOCK.UPDATE,
    });
    if (!loan) throw new NotFoundError('Loan not found');
    if (loan.memberId !== member.id) throw new ForbiddenError('You do not own this loan');
    if (!['ACTIVE', 'APPROVED', 'DISBURSED'].includes(String(loan.status).toUpperCase())) {
      throw new ValidationError('Loan is not eligible for repayment');
    }

    const previousPrincipalPayments = loan.principalBalance == null
      ? Number(await db.LoanTransaction.sum('principalPaid', { where: { loanId: loan.id }, transaction: dbTransaction }) || 0)
      : 0;
    const principal = Number(loan.principalBalance == null ? loan.amount - previousPrincipalPayments : loan.principalBalance);
    const accrualStart = new Date(loan.lastInterestAccrualAt || loan.decidedAt || loan.updatedAt || loan.createdAt);
    const paymentDate = new Date();
    const accruedDays = Math.max(0, Math.floor((paymentDate.getTime() - accrualStart.getTime()) / 86400000));
    const dailyRate = (Number(loan.interestRate || 0) / 100) / 30;
    const accruedInterest = Math.round((Number(loan.accruedInterest || 0) + principal * dailyRate * accruedDays) * 100) / 100;
    const outstanding = Math.round((principal + accruedInterest) * 100) / 100;
    if (amount > outstanding) throw new ValidationError(`Payment exceeds the outstanding loan balance of KES ${outstanding.toFixed(2)}`);

    const interestPaid = Math.min(amount, accruedInterest);
    const principalPaid = Math.min(amount - interestPaid, principal);
    const remainingPrincipal = Math.round((principal - principalPaid) * 100) / 100;
    const remainingInterest = Math.round((accruedInterest - interestPaid) * 100) / 100;
    const reference = req.body.reference || `REPAY-${Date.now()}`;
    const ledger = await db.Transaction.create({
      memberId: member.id, loanId: loan.id, type: 'LOAN_REPAYMENT', amount,
      method: req.body.method || 'MANUAL', status: 'SUCCESS', reference,
      description: 'Interim reducing-balance loan payment', paymentCategory: 'loan_interim_payment',
    }, { transaction: dbTransaction });
    const repayment = await db.LoanTransaction.create({
      loanId: loan.id, memberId: member.id, ledgerTransactionId: ledger.id,
      transactionType: 'INTERIM_PAYMENT', amount, principalPaid, interestPaid,
      remainingPrincipal, accruedDays,
      metadata: { rateBasis: 'MONTHLY_REDUCING_BALANCE', monthlyRate: Number(loan.interestRate || 0), reference },
    }, { transaction: dbTransaction });
    const startDate = new Date(loan.decidedAt || loan.createdAt);
    const elapsedMonths = Math.max(0, (paymentDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + paymentDate.getUTCMonth() - startDate.getUTCMonth());
    const remainingInstallments = Math.max(Number(loan.duration || 1) - elapsedMonths, 1);
    let nextPaymentDueAt = null;
    if (remainingPrincipal !== 0 || remainingInterest !== 0) {
      nextPaymentDueAt = addScheduleMonths(startDate, Math.min(elapsedMonths + 1, Number(loan.duration || 1)));
      if (nextPaymentDueAt <= paymentDate) nextPaymentDueAt = addScheduleMonths(startDate, elapsedMonths + 2);
    }
    await loan.update({
      principalBalance: remainingPrincipal, accruedInterest: remainingInterest,
      lastInterestAccrualAt: paymentDate,
      nextPaymentDueAt,
      status: remainingPrincipal === 0 && remainingInterest === 0 ? 'COMPLETED' : loan.status,
    }, { transaction: dbTransaction });
    return { ledger, repayment, paymentDate, loanId: loan.id, remainingInterest, nextPaymentDueAt, remainingInstallments };
  });
  await releaseCoveredGuarantors(result.loanId);

  return ResponseHandler.created(res, {
    id: result.ledger.id, type: result.ledger.type, amount: Number(result.ledger.amount),
    transactionType: result.repayment.transactionType,
    principalPaid: Number(result.repayment.principalPaid), interestPaid: Number(result.repayment.interestPaid),
    remainingPrincipal: Number(result.repayment.remainingPrincipal), accruedDays: result.repayment.accruedDays,
    remainingInterest: result.remainingInterest,
    outstandingBalance: Number(result.repayment.remainingPrincipal) + result.remainingInterest,
    nextPaymentDueAt: result.nextPaymentDueAt,
    nextPaymentAmount: result.remainingInstallments ? (Number(result.repayment.remainingPrincipal) + result.remainingInterest) / result.remainingInstallments : 0,
    status: result.ledger.status, method: result.ledger.method, reference: result.ledger.reference,
    createdAt: result.paymentDate, createdAtEAT: formatEAT(result.paymentDate),
  }, 'Interim loan payment allocated and schedule recalculated successfully');
});

const initiateLoanRepaymentStk = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');
  const loan = await db.Loan.findByPk(req.params.loanId);
  if (!loan) throw new NotFoundError('Loan not found');
  if (loan.memberId !== member.id) throw new ForbiddenError('You do not own this loan');
  if (!['ACTIVE', 'APPROVED', 'DISBURSED'].includes(String(loan.status).toUpperCase())) throw new ValidationError('Loan is not eligible for repayment');
  const amount = Number(req.body.amount);
  const phone = String(req.body.phone || '').replace(/\s+/g, '');
  const principal = Number(loan.principalBalance ?? loan.amount ?? 0);
  const accrualStart = new Date(loan.lastInterestAccrualAt || loan.decidedAt || loan.createdAt);
  const accruedDays = Math.max(0, Math.floor((Date.now() - accrualStart.getTime()) / 86400000));
  const liveInterest = Number(loan.accruedInterest || 0) + principal * (Number(loan.interestRate || 0) / 100 / 30) * accruedDays;
  const outstanding = principal + liveInterest;
  if (!Number.isInteger(amount) || amount <= 0 || amount > outstanding) throw new ValidationError(`Enter a whole-shilling amount between KES 1 and KES ${outstanding.toFixed(2)}`);
  if (!/^(?:254|0)?7\d{8}$/.test(phone)) throw new ValidationError('Enter a valid Kenyan M-Pesa phone number');

  const internalReference = `LOAN-${loan.id}-${Date.now()}`;
  if (!member.memberNumber) throw new ValidationError('Your member number is required before an M-Pesa loan repayment can be initiated');
  const memberAccountReference = String(member.memberNumber);
  const ledger = await db.Transaction.create({
    memberId: member.id, loanId: loan.id, type: 'LOAN_REPAYMENT', amount,
    method: 'MPESA', status: 'PENDING', reference: internalReference,
    internalReference, description: `Loan repayment for member ${memberAccountReference}`,
    paymentCategory: 'loan_repayment', kcbEndpoint: '/loans_repayment', promptChannel: 'STK',
  });
  try {
    const baseUrl = getKcbMpesaBaseUrl();
    if (!baseUrl) throw new Error('M-Pesa STK Push is not configured');
    const upstream = await fetch(`${baseUrl}/loans_repayment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone, amount: Math.round(amount), accountReference: memberAccountReference,
        AccountReference: memberAccountReference, transactionDesc: `Loan repayment - ${memberAccountReference}`,
        TransactionDesc: `Loan repayment - ${memberAccountReference}`, loanId: loan.id, memberId: member.id,
        member_number: memberAccountReference,
        type: 'LOAN_REPAYMENT', method: 'MPESA', paymentCategory: 'loan_repayment', internalReference,
      }),
    });
    const payload = await upstream.json();
    const checkoutRequestId = payload.checkoutRequestId || payload.CheckoutRequestID;
    if (!upstream.ok || !checkoutRequestId) throw new Error(payload.message || payload.error || 'M-Pesa did not return a checkout request ID');
    await ledger.update({ checkoutRequestId, merchantRequestId: payload.merchantRequestId || payload.MerchantRequestID || null, reference: checkoutRequestId });
    return ResponseHandler.success(res, { transactionId: ledger.id, checkoutRequestId, merchantRequestId: ledger.merchantRequestId, status: 'PENDING' }, 'STK Push Sent!', 200);
  } catch (error) {
    await ledger.update({ status: 'FAILED', description: error.message });
    throw new ValidationError(error.message || 'Unable to send M-Pesa PIN prompt');
  }
});

const getLoanPaymentStatus = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  const ledger = member ? await db.Transaction.findOne({ where: { memberId: member.id, checkoutRequestId: req.params.checkoutRequestId, type: 'LOAN_REPAYMENT' } }) : null;
  if (!ledger) throw new NotFoundError('Payment request not found');
  const repayment = await db.LoanTransaction.findOne({ where: { ledgerTransactionId: ledger.id } });
  return ResponseHandler.success(res, {
    checkoutRequestId: ledger.checkoutRequestId, status: ledger.status,
    mpesaReceiptNumber: ledger.status === 'SUCCESS' ? ledger.reference : null,
    principalPaid: repayment ? Number(repayment.principalPaid) : null,
    interestPaid: repayment ? Number(repayment.interestPaid) : null,
    remainingBalance: repayment ? Number(repayment.remainingPrincipal) + Number(repayment.metadata?.remaining_interest || 0) : null,
  }, 'Payment status retrieved');
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
  const memberPaymentAccount = /^29903-\d+$/i.test(String(memberNumber || ''))
    ? memberNumber
    : String(memberNumber || '').trim();

  if (paymentMode === 'STK' && !phone) {
    throw new ValidationError('Phone number is required for STK push');
  }

  if (!memberPaymentAccount || /^AYEDOSSACCO/i.test(memberPaymentAccount)) {
    throw new ValidationError('Your member number is not available yet. Please refresh your profile before making this payment.');
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
      invoiceNumber: memberPaymentAccount,
      accountReference: memberPaymentAccount,
      member_number: memberPaymentAccount,
      memberId: member.id,
      type: promptType.transactionType,
      method: 'MPESA',
      paymentCategory: promptType.category,
      kcbEndpoint: endpoint,
      internalReference: reference,
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
  const transactionHeavyReports = new Set(['transactions', 'loans', 'loan-repayment', 'withdrawals', 'portfolio']);
  const member = await findMemberByUserId(req.user.id);
  const dateFilter = durationMonths > 0 ? { createdAt: { [Op.gte]: new Date(new Date().setMonth(new Date().getMonth() - durationMonths)) } } : {};
  const transactions = member
    ? await db.Transaction.findAll({
      where: {
        memberId: member.id,
        ...dateFilter,
        status: { [Op.in]: ['SUCCESS', 'PAID', 'COMPLETED'] },
      },
      order: [['createdAt', 'DESC']],
      limit: transactionHeavyReports.has(reportType) ? 100 : 20,
    })
    : [];
  const loans = member
    ? await db.Loan.findAll({
      where: { memberId: member.id, ...dateFilter },
      include: [{
        model: db.Guarantor,
        include: [{
          model: db.Member,
          include: [db.User],
        }],
      }],
      order: [['createdAt', 'DESC']],
    })
    : [];
  const shares = await shareService.getShareAccountsForUser(req.user);

  const successfulTransactions = transactions;
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
  const paidShareCapital = categoryTotal(['share_capital', 'sharecapital', 'share capital']);
  const shareAccountCapital = shares.reduce((sum, share) => sum + Number((share.shares || 0) * (share.shareValue || 0)), 0);
  const shareCapital = Math.max(paidShareCapital, shareAccountCapital);
  const savingsTotal = categoryTotal(['savings']);
  const outstandingLoans = loans.reduce((sum, loan) => sum + Number(loan.amount || 0), 0);
  const transactionTotal = successfulTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const durationLabel = durationMonths > 0 ? `Last ${durationMonths} month${durationMonths === 1 ? '' : 's'}` : 'All records';
  const memberNumber = member?.memberNumber || user.memberNumber || 'Member';
  const reportName = reportNames[reportType] || 'Portfolio Report';
  const sections = buildReportSections({ reportType, transactions: successfulTransactions, loans, shares });
  const portfolioSummaryRows = [
    ['Share capital', `KES ${formatMoney(shareCapital)}`],
    ['Savings', `KES ${formatMoney(savingsTotal)}`],
    ['Outstanding loans', `KES ${formatMoney(outstandingLoans)}`],
    ['Successful transaction total', `KES ${formatMoney(transactionTotal)}`],
    ['Loans', loans.length],
  ];
  const transactionSummaryRows = [
    ['Share capital', `KES ${formatMoney(shareCapital)}`],
    ['Savings', `KES ${formatMoney(savingsTotal)}`],
  ];
  const summaryRows = reportType === 'transactions' ? transactionSummaryRows : portfolioSummaryRows;
  const reportPdf = buildBrandedReportPdf({
    memberNumber,
    reportName,
    durationLabel,
    sections,
    summaryRows,
  });

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
    from: `"AYEDOS SACCO" <${process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER}>`,
    to: user.email,
    subject: `AYEDOS SACCO ${reportType} report`,
    html: buildReportEmail({
      recipientName: user.name,
      reportType: reportName,
      summaryRows,
    }),
    attachments: [
      ...getBrandLogoAttachments(),
      {
        filename: `${memberNumber} - ${reportName}.pdf`.replace(/[\\/:*?"<>|]/g, '-'),
        content: reportPdf,
        contentType: 'application/pdf',
      },
    ],
  });

  return ResponseHandler.success(res, null, 'Report sent to your email', 200);
});

module.exports = {
  getProfile,
  uploadProfilePhoto,
  uploadKycDocuments,
  updateProfile,
  transferShareCapital,
  requestOptOut,
  getLoans,
  applyForLoan,
  cancelLoan,
  repayLoan,
  initiateLoanRepaymentStk,
  getLoanPaymentStatus,
  depositSavings,
  initiateContribution,
  checkContributionStatus,
  getShares,
  buyShares,
  getTransactions,
  searchGuarantors,
  getGuarantees,
  emailReport,
};
