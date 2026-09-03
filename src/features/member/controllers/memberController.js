const { Op } = require('sequelize');
const db = require('../../../models');
const userService = require('../../users/services/userService');
const loanService = require('../../loans/services/loanService');
const shareService = require('../../shares/services/shareService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const { UserDTO, LoanDTO, TransactionDTO, sanitizeMemberForPrivateProfile } = require('../../../shared/utils/dtos');
const logger = require('../../../shared/utils/logger');
const notificationService = require('../../notifications/services/notificationService');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const { buildReportEmail, getBrandLogoAttachments } = require('../../../services/email/templates');
const { buildBrandedReportPdf } = require('../../../services/reports/pdfReport');
const { buildReportSections, formatMoney, reportNames } = require('../../../services/reports/reportTemplates');
const shareCapitalTransferService = require('../../shares/services/shareCapitalTransferService');
const memberNumberService = require('../services/memberNumberService');
const { allocateMpesaRepayment } = require('../../loans/services/loanRepaymentService');
const { calculateCurrentOutstandingBalance, calculateLoanBalanceQuote } = require('../../loans/services/loanCalculationEngine');
const { isShareCapitalPayment, settleShareCapitalPayment } = require('../../shares/services/shareCapitalPaymentService');
const { formatEAT } = require('../../../shared/utils/eatDateTime');
const { getFirebaseDb, getFirebaseStorage } = require('../../../shared/config/firebase');
const { generateOTP } = require('../../../shared/utils/generateOTP');
const otpService = require('../../../services/otpService');
const { enqueueEmail, QUEUES } = require('../../../services/email/emailQueue');
const { sendOtpSms } = require('../../../services/sms/smsService');
const walletService = require('../../wallet/services/walletService');
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
const LOAN_REPAYMENT_STK_TIMEOUT_MS = Number(process.env.LOAN_REPAYMENT_STK_TIMEOUT_MS || 45000);
const MINIMUM_LOAN_SHARE_CAPITAL = 20000;
const LOAN_ELIGIBILITY_MESSAGE = 'You are not yet eligible to apply for a loan. Please complete the minimum required share capital purchase before submitting a loan application.';
const SELF_GUARANTEE_MULTIPLIER = Number(process.env.SELF_GUARANTEE_SAVINGS_MULTIPLIER || 1);

const KENYA_PAYOUT_BANKS = [
  { name: 'KCB Bank Kenya', code: '01', swiftCode: 'KCBLKENX', branchCode: '01000' },
  { name: 'Standard Chartered Bank Kenya', code: '02', swiftCode: 'SCBLKENX', branchCode: '02000' },
  { name: 'Absa Bank Kenya', code: '03', swiftCode: 'BARCKENX', branchCode: '03000' },
  { name: 'Bank of Baroda Kenya', code: '06', swiftCode: 'BARBKENA', branchCode: '06000' },
  { name: 'NCBA Bank Kenya', code: '07', swiftCode: 'CBAFKENX', branchCode: '07000' },
  { name: 'Prime Bank', code: '10', swiftCode: 'PRIEKENX', branchCode: '10000' },
  { name: 'Co-operative Bank of Kenya', code: '11', swiftCode: 'KCOOKENA', branchCode: '11000' },
  { name: 'National Bank of Kenya', code: '12', swiftCode: 'NBKEKENX', branchCode: '12000' },
  { name: 'M-Oriental Bank', code: '14', swiftCode: 'MORBKENA', branchCode: '14000' },
  { name: 'Citibank Kenya', code: '16', swiftCode: 'CITIKENA', branchCode: '16000' },
  { name: 'Habib Bank AG Zurich', code: '17', swiftCode: 'HBZUKENA', branchCode: '17000' },
  { name: 'Middle East Bank Kenya', code: '18', swiftCode: 'MIEKKENA', branchCode: '18000' },
  { name: 'Bank of Africa Kenya', code: '19', swiftCode: 'AFRIKENX', branchCode: '19000' },
  { name: 'Consolidated Bank of Kenya', code: '23', swiftCode: 'CONKKENA', branchCode: '23000' },
  { name: 'Credit Bank', code: '25', swiftCode: 'CRBTKENA', branchCode: '25000' },
  { name: 'Access Bank Kenya', code: '26', swiftCode: 'ABNGKENA', branchCode: '26000' },
  { name: 'Stanbic Bank Kenya', code: '31', swiftCode: 'SBICKENX', branchCode: '31000' },
  { name: 'African Banking Corporation Kenya', code: '35', swiftCode: 'ABCLKENA', branchCode: '35000' },
  { name: 'Spire Bank', code: '49', swiftCode: 'EQBLKENA', branchCode: '49000' },
  { name: 'Paramount Bank', code: '50', swiftCode: 'PAUTKENA', branchCode: '50000' },
  { name: 'Kingdom Bank', code: '51', swiftCode: 'CIFIKENA', branchCode: '51000' },
  { name: 'Guaranty Trust Bank Kenya', code: '53', swiftCode: 'GTBIKENA', branchCode: '53000' },
  { name: 'Victoria Commercial Bank', code: '54', swiftCode: 'VICMKENA', branchCode: '54000' },
  { name: 'Guardian Bank', code: '55', swiftCode: 'GUARKENA', branchCode: '55000' },
  { name: 'I&M Bank Kenya', code: '57', swiftCode: 'IMBLKENA', branchCode: '57000' },
  { name: 'Development Bank of Kenya', code: '59', swiftCode: 'DEVKKENA', branchCode: '59000' },
  { name: 'Sidian Bank', code: '66', swiftCode: 'SIDNKENA', branchCode: '66000' },
  { name: 'Equity Bank Kenya', code: '68', swiftCode: 'EQBLKENA', branchCode: '68000' },
  { name: 'Family Bank', code: '70', swiftCode: 'FABLKENA', branchCode: '70000' },
  { name: 'Gulf African Bank', code: '72', swiftCode: 'GAFRKENA', branchCode: '72000' },
  { name: 'First Community Bank', code: '74', swiftCode: 'IFCBKENA', branchCode: '74000' },
  { name: 'DIB Bank Kenya', code: '75', swiftCode: 'DUIBKENA', branchCode: '75000' },
  { name: 'UBA Kenya Bank', code: '76', swiftCode: 'UNAFKENA', branchCode: '76000' },
  { name: 'KWFT Bank', code: '78', swiftCode: 'KWFTKENA', branchCode: '78000' },
  { name: 'Faulu Microfinance Bank', code: '79', swiftCode: 'FAUMKENA', branchCode: '79000' },
  { name: 'Choice Microfinance Bank', code: '36', swiftCode: 'CHOIKENA', branchCode: '36000' },
  { name: 'Sendwave Remittance', code: 'SENDWAVE', swiftCode: 'SENDWAVE', branchCode: 'SWV001', channel: 'SENDWAVE' },
];

const getKcbMpesaBaseUrl = () => process.env.MPESA_URL?.trim().replace(/\/+$/, '') || null;
const getBackendCallbackUrl = (req) => {
  const configured = process.env.BACKEND_BASE_URL
    || process.env.PUBLIC_BACKEND_URL
    || process.env.API_PUBLIC_URL
    || process.env.APP_BASE_URL;
  const baseUrl = configured?.trim().replace(/\/+$/, '')
    || `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
  return `${baseUrl}/api/mpesa/callback`;
};

const normalizeMpesaPhone = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('2540') && digits.length === 13) digits = `254${digits.slice(4)}`;
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return digits;
};

const isValidMpesaPhone = (value) => /^254[17]\d{8}$/.test(value);

const shouldUseLocalStkFallback = () => process.env.NODE_ENV !== 'production'
  && process.env.MPESA_STK_ALLOW_LOCAL_FALLBACK !== 'false';

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
        if (providerStatus === 'SUCCESS' && isShareCapitalPayment(transaction)) {
          const settled = await settleShareCapitalPayment({
            transactionId: transaction.id,
            receipt,
            amount: providerTransaction.amount,
            description: providerTransaction.description,
          });
          transaction.set({ status: settled.status, reference: settled.reference, amount: settled.amount });
        } else {
          await transaction.update({
            status: providerStatus,
            reference: receipt || transaction.reference,
            providerTransactionId: providerTransaction.id,
            providerInternalReference: providerTransaction.internalReference
              || transaction.providerInternalReference,
          });
        }
        if (providerStatus === 'SUCCESS' && !isShareCapitalPayment(transaction)) {
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
    if (isShareCapitalPayment(transaction)) {
      const settled = await settleShareCapitalPayment({ transactionId: transaction.id, receipt });
      transaction.set({ status: settled.status, reference: settled.reference, amount: settled.amount });
    } else {
      await transaction.update({
        status: 'SUCCESS',
        reference: receipt || transaction.reference,
      });
      await applyLoanRepaymentLink(transaction);
    }
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
  return ResponseHandler.success(res, { ...UserDTO.private(user), Member: sanitizeMemberForPrivateProfile(user.Member || member), nominees: member?.nominees || [] }, 'Profile retrieved successfully');
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
  let updated = await userService.updateUser(req.user.id, safeBody);
  if (!updated) {
    throw new NotFoundError('User not found');
  }
  const member = await findMemberByUserId(req.user.id);
  if (nominees !== undefined && member) await member.update({ nominees });
  updated = await userService.getUserById(req.user.id);
  const refreshedMember = updated?.Member || member;
  return ResponseHandler.success(res, { ...UserDTO.private(updated), Member: sanitizeMemberForPrivateProfile(refreshedMember), nominees: refreshedMember?.nominees || [] }, 'Profile updated successfully', 200);
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

const searchOptOutTransferees = asyncHandler(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) {
    return ResponseHandler.success(res, [], 'Enter at least 2 characters to search members', 200);
  }

  const currentMember = await findMemberByUserId(req.user.id);
  const members = await db.Member.findAll({
    where: {
      id: { [Op.ne]: currentMember?.id || null },
      status: { [Op.ne]: 'TERMINATED' },
      [Op.or]: [
        { memberNumber: { [Op.iLike]: `%${term}%` } },
        { '$User.name$': { [Op.iLike]: `%${term}%` } },
        { '$User.firstName$': { [Op.iLike]: `%${term}%` } },
        { '$User.lastName$': { [Op.iLike]: `%${term}%` } },
        { '$User.phone$': { [Op.iLike]: `%${term}%` } },
      ],
    },
    include: [{
      model: db.User,
      attributes: ['id', 'name', 'firstName', 'lastName', 'phone', 'email'],
    }],
    limit: 8,
    order: [['memberNumber', 'ASC']],
    subQuery: false,
  });

  const rows = await Promise.all(members.map(async (member) => {
    const user = member.User || {};
    const balances = await getMemberExitBalances(member.id);
    const activeLoanBalance = await db.Loan.sum('principalBalance', {
      where: {
        memberId: member.id,
        status: { [Op.in]: ['PENDING', 'PENDING_GUARANTORS', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE'] },
      },
    });
    const fallbackLoanAmount = activeLoanBalance ? 0 : await db.Loan.sum('amount', {
      where: {
        memberId: member.id,
        status: { [Op.in]: ['PENDING', 'PENDING_GUARANTORS', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE'] },
      },
    });
    return {
      memberId: member.id,
      memberNumber: member.memberNumber,
      fullName: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || member.memberNumber,
      phone: user.phone || null,
      email: user.email || null,
      shareCapital: Number(balances.shareCapital || 0),
      savings: Number(balances.savings || 0),
      loanBalance: Number(activeLoanBalance || fallbackLoanAmount || 0),
      status: member.status || 'ACTIVE',
    };
  }));

  return ResponseHandler.success(res, rows, 'Opt-out transferees retrieved successfully', 200);
});

const sendOptOutOtp = asyncHandler(async (req, res) => {
  const user = await db.User.findByPk(req.user.id);
  if (!user) throw new NotFoundError('User not found');
  const member = await findMemberByUserId(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');

  const activeOtpSession = await otpService.getActiveOtpSession({ userId: user.id, purpose: 'OPT_OUT' });
  if (activeOtpSession) otpService.assertResendAllowed(activeOtpSession);

  const otp = generateOTP();
  await otpService.createOtpSession({ userId: user.id, purpose: 'OPT_OUT', otp });
  await enqueueEmail(QUEUES.OTP, 'OTP', { to: user.email, otp, recipientName: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Member' }, { immediate: true }).catch((error) => {
    logger.error('Opt-out OTP email delivery failed', { module: 'member', userId: user.id, error: error.message });
  });
  sendOtpSms({ to: user.phone, otp, purpose: 'OPT_OUT' }).catch((error) => {
    logger.error('Opt-out OTP SMS delivery failed', { module: 'member', userId: user.id, error: error.message });
  });

  return ResponseHandler.success(res, {
    email: user.email,
    phone: user.phone,
    resendAvailableIn: 60,
  }, 'OTP sent to your registered email and phone number', 200);
});

const requestOptOut = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }
  await otpService.verifyOtp({ userId: req.user.id, purpose: 'OPT_OUT', otp: req.body.otp });

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
  const transferAmount = req.body.transferAmount ? Number(req.body.transferAmount) : null;
  const request = await db.MemberExitRequest.create({
    memberId: member.id,
    savingsWithdrawalAmount: balances.savings,
    shareCapitalAmount: balances.shareCapital,
    saccoFeeAmount: balances.saccoFee,
    auctionAmount: balances.auctionAmount,
    buyerMemberNumber: req.body.buyerMemberNumber || null,
    transfereeInfo: req.body.transfereeInfo || null,
    reason: req.body.reason || null,
    uploadedFormName: req.body.uploadedFormName || null,
    uploadedFormDataUrl: req.body.uploadedFormDataUrl || null,
    acknowledgedTerms: req.body.acknowledgedTerms,
    requestedAt: new Date(),
    adminApproval: false,
    financeApproval: false,
    status: 'PENDING',
    metadata: {
      submittedFrom: 'member_portal',
      otpVerified: true,
      formUploaded: Boolean(req.body.uploadedFormDataUrl || req.body.uploadedFormName),
      transfereeMemberId: req.body.transfereeMemberId || null,
      transferAmount,
    },
  });
  await notificationService.createOptOutReviewNotifications(request.id);
  await db.Notification.create({
    userId: req.user.id,
    eventKey: `opt-out-submitted:${request.id}`,
    title: 'Opt-out request sent',
    body: 'Your request to exit has been sent to the Admin and is currently being reviewed. This process typically takes three (3) business days.',
    category: 'opt_out',
    severity: 'warning',
    actionUrl: '/dashboard/member/notifications',
    sourceType: 'MemberExitRequest',
    sourceId: request.id,
    metadata: { requestId: request.id, status: request.status },
  }).catch(() => null);
  if (req.body.transfereeMemberId) {
    const transferee = await db.Member.findByPk(req.body.transfereeMemberId, { include: [db.User] }).catch(() => null);
    if (transferee?.User?.id) {
      await db.Notification.create({
        userId: transferee.User.id,
        eventKey: `opt-out-transferee:${request.id}:${transferee.id}`,
        title: 'Incoming share capital transfer',
        body: `${req.user.name || req.user.email || 'A member'} listed you as the transferee for an opt-out share capital transfer of ${transferAmount ? `KES ${transferAmount.toLocaleString()}` : 'their share capital'} on ${new Date().toLocaleDateString()}. Transferor member number: ${member.memberNumber || 'N/A'}.`,
        category: 'opt_out',
        severity: 'info',
        actionUrl: '/dashboard/member/notifications',
        sourceType: 'MemberExitRequest',
        sourceId: request.id,
        metadata: {
          requestId: request.id,
          transferorMemberId: member.id,
          transferorMemberNumber: member.memberNumber,
          transferAmount,
          transactionDate: new Date(),
        },
      }).catch(() => null);
    }
  }

  return ResponseHandler.success(res, {
    id: request.id,
    status: request.status,
    savingsWithdrawalAmount: request.savingsWithdrawalAmount,
    shareCapitalAmount: request.shareCapitalAmount,
    saccoFeeAmount: request.saccoFeeAmount,
    auctionAmount: request.auctionAmount,
    buyerMemberNumber: request.buyerMemberNumber,
    transfereeInfo: request.transfereeInfo,
    uploadedFormName: request.uploadedFormName,
    requestedAt: request.requestedAt,
  }, 'Opt-out request submitted successfully', 201);
});

const getWalletCashOutSummary = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');

  const walletMemberId = String(member.memberNumber || member.id).slice(0, 32);
  const walletId = `WAL-${walletMemberId}`.slice(0, 32);
  const { wallet, latestBlock, integrityVerified } = await walletService.getSummary(walletId).catch((error) => {
    if (error.statusCode === 404) {
      return {
        wallet: {
          walletId,
          memberId: walletMemberId,
          status: 'ACTIVE',
          depositedBalance: 0,
          withdrawableBalance: 0,
          updatedAt: null,
        },
        latestBlock: null,
        integrityVerified: true,
      };
    }
    throw error;
  });

  return ResponseHandler.success(res, {
    walletId: wallet.walletId || wallet.id || walletId,
    memberId: walletMemberId,
    memberNumber: member.memberNumber,
    availableBalance: Number(wallet.withdrawableBalance || 0),
    depositedBalance: Number(wallet.depositedBalance || 0),
    status: wallet.status,
    banks: KENYA_PAYOUT_BANKS,
    audit: {
      latestBlockNumber: latestBlock ? Number(latestBlock.blockNumber) : null,
      integrityVerified,
    },
  }, 'Wallet cash-out summary retrieved successfully', 200);
});

const sendCashOutOtp = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user.email && !user.phone) {
    throw new ValidationError('Email address or mobile phone number is required before withdrawal verification codes can be sent.');
  }
  const activeSession = await otpService.getActiveOtpSession({ userId: user.id, purpose: 'CASH_OUT' });
  otpService.assertResendAllowed(activeSession);
  const otp = generateOTP();
  await otpService.createOtpSession({ userId: user.id, purpose: 'CASH_OUT', otp });
  if (user.email) {
    await enqueueEmail(QUEUES.OTP, 'OTP', {
      to: user.email,
      otp,
      recipientName: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Member',
    }, { immediate: true }).catch((error) => logger.error('Cash-out OTP email delivery failed', { module: 'member', userId: user.id, error: error.message }));
  }
  if (user.phone) {
    sendOtpSms({ to: user.phone, otp, purpose: 'CASH_OUT' }).catch((error) => {
      logger.error('Cash-out OTP SMS delivery failed', { module: 'member', userId: user.id, error: error.message });
    });
  }

  return ResponseHandler.success(res, {
    email: user.email,
    phone: user.phone,
    resendAvailableIn: 60,
  }, 'Cash-out OTP sent to your registered email and phone number', 200);
});

const sendLoanPayoutOtp = asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user.phone) {
    throw new ValidationError('A mobile phone number must be attached to your account before payout verification can be sent.');
  }
  const activeSession = await otpService.getActiveOtpSession({ userId: user.id, purpose: 'LOAN_PAYOUT' });
  otpService.assertResendAllowed(activeSession);
  const otp = generateOTP();
  await otpService.createOtpSession({ userId: user.id, purpose: 'LOAN_PAYOUT', otp });
  sendOtpSms({ to: user.phone, otp, purpose: 'LOAN_PAYOUT' }).catch((error) => {
    logger.error('Loan payout OTP SMS delivery failed', { module: 'member', userId: user.id, error: error.message });
  });

  return ResponseHandler.success(res, {
    phone: user.phone,
    resendAvailableIn: 60,
  }, 'Payout verification OTP sent to your registered mobile number', 200);
});

const cashOutWallet = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) throw new NotFoundError('Member profile not found');
  await otpService.verifyOtp({ userId: req.user.id, purpose: 'CASH_OUT', otp: req.body.otp });

  const amount = Number(req.body.amount || 0);
  if (!amount || amount <= 0) throw new ValidationError('Enter a valid withdrawal amount');

  const channel = String(req.body.channel || 'MPESA').toUpperCase();
  const walletMemberId = String(member.memberNumber || member.id).slice(0, 32);
  const walletId = req.body.walletId || `WAL-${walletMemberId}`.slice(0, 32);
  const selectedBank = channel === 'BANK' || channel === 'SENDWAVE'
    ? KENYA_PAYOUT_BANKS.find((bank) => bank.code === req.body.bankCode || bank.name === req.body.bankName)
    : null;

  if (channel === 'BANK' && !selectedBank) throw new ValidationError('Select a valid Kenyan commercial bank');
  if (channel === 'SENDWAVE' && !KENYA_PAYOUT_BANKS.some((bank) => bank.channel === 'SENDWAVE')) throw new ValidationError('Sendwave payout route is unavailable');
  if (channel === 'MPESA' && !isValidMpesaPhone(normalizeMpesaPhone(req.body.phoneNumber))) throw new ValidationError('Enter a valid Kenyan M-Pesa phone number');

  const result = await walletService.withdraw({
    member_id: walletMemberId,
    wallet_id: walletId,
    amount,
    channel,
    phone_number: channel === 'MPESA' ? normalizeMpesaPhone(req.body.phoneNumber) : undefined,
    bank: selectedBank ? {
      name: selectedBank.name,
      code: selectedBank.code,
      branchCode: req.body.branchCode || selectedBank.branchCode,
      swiftCode: req.body.swiftCode || selectedBank.swiftCode,
    } : null,
    beneficiary: channel !== 'MPESA' ? {
      accountNumber: req.body.accountNumber,
      accountName: req.body.accountName,
    } : null,
    telemetry: {
      device_id: req.get('X-Device-Id') || req.body.telemetry?.device_id || req.sessionId || 'member-dashboard',
      ip_address: req.ip,
      gps_location: req.body.telemetry?.gps_location || 'member-confirmed',
      operating_system: req.body.telemetry?.operating_system || null,
      app_version: req.body.telemetry?.app_version || null,
    },
  });

  if (result.rejected) {
    return ResponseHandler.success(res, {
      status: 'REJECTED',
      transactionId: result.rejected.transactionId,
      risk: result.risk,
    }, 'Withdrawal rejected by risk controls', 200);
  }
  if (result.failed) {
    return ResponseHandler.success(res, {
      status: 'FAILED',
      transactionId: result.failed.transactionId,
      risk: result.risk,
    }, 'Withdrawal payout failed', 200);
  }

  return ResponseHandler.success(res, {
    status: 'SUCCESS',
    transactionId: result.verified.transactionId,
    amount: Number(result.verified.amount),
    channel,
    externalReference: result.verified.externalReference,
    newWithdrawableBalance: Number(result.verified.newWithdrawableBalance),
    blockchain: {
      blockNumber: Number(result.block.blockNumber),
      transactionHash: result.block.transactionHash,
      blockHash: result.block.currentHash,
    },
    risk: result.risk,
  }, 'Withdrawal processed successfully', 200);
});

const validateLoanPayoutDestination = (payoutDestination = {}) => {
  const channel = String(payoutDestination.channel || '').toUpperCase();
  if (!['MPESA', 'BANK', 'SENDWAVE'].includes(channel)) {
    throw new ValidationError('Select a valid disbursement and withdrawal method');
  }
  if (channel === 'MPESA') {
    const phone = normalizeMpesaPhone(payoutDestination.phoneNumber);
    if (!isValidMpesaPhone(phone)) throw new ValidationError('Enter a valid M-Pesa payout phone number');
    return { channel, phoneNumber: phone };
  }

  const selectedBank = KENYA_PAYOUT_BANKS.find((bank) => (
    channel === 'SENDWAVE'
      ? bank.channel === 'SENDWAVE'
      : bank.code === payoutDestination.bankCode || bank.name === payoutDestination.bankName
  ));
  if (!selectedBank) throw new ValidationError(channel === 'SENDWAVE' ? 'Select a valid Sendwave payout route' : 'Select a valid Kenyan commercial bank');
  if (!String(payoutDestination.accountNumber || '').trim()) throw new ValidationError('Beneficiary account number is required');
  if (!String(payoutDestination.accountName || '').trim()) throw new ValidationError('Account holder name is required');

  return {
    channel,
    bankName: selectedBank.name,
    bankCode: selectedBank.code,
    branchCode: payoutDestination.branchCode || selectedBank.branchCode,
    swiftCode: payoutDestination.swiftCode || selectedBank.swiftCode,
    accountNumberLast4: String(payoutDestination.accountNumber).slice(-4),
    accountName: String(payoutDestination.accountName).trim(),
  };
};

const buildPayoutReasonNote = (payout) => {
  if (payout.channel === 'MPESA') return `Preferred payout: M-Pesa ${payout.phoneNumber}.`;
  return `Preferred payout: ${payout.channel === 'SENDWAVE' ? 'Sendwave' : 'Bank Transfer'} via ${payout.bankName}, branch ${payout.branchCode}, swift ${payout.swiftCode}, account ending ${payout.accountNumberLast4}, holder ${payout.accountName}.`;
};

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
          attributes: ['id', 'name', 'firstName', 'lastName', 'email', 'phone'],
        }],
      }],
    }, {
      model: db.LoanTransaction,
      as: 'loanTransactions',
      separate: true,
      order: [['createdAt', 'DESC']],
    }],
    order: [['createdAt', 'DESC']],
  });
  const formatted = loans.map((loan) => {
    const quote = calculateLoanBalanceQuote(loan);
    const outstandingBalance = quote.outstandingBalance;
    const isImportedLiabilityStatement = loan.reason === 'Imported account liability statement';
    return ({
    id: loan.id,
    memberId: loan.memberId,
    type: loan.type,
    source: isImportedLiabilityStatement ? 'AccountLiabilityStatement' : 'Loan',
    sourceLabel: isImportedLiabilityStatement ? 'Account liability statement' : null,
    isImportedLiabilityStatement,
    principal: loan.amount,
    principalBalance: Number(loan.principalBalance ?? loan.amount ?? 0),
    accruedInterest: Number(loan.accruedInterest || 0),
    currentAccruedInterest: quote.accruedInterest,
    accruedDays: quote.accruedDays,
    remainingInstallments: quote.remainingInstallments,
    scheduledPaymentAmount: quote.scheduledPaymentAmount,
    daysPastDue: quote.daysPastDue,
    amortizationMethod: quote.amortization,
    // Use the same current, reducing-balance quote shown by every member view.
    // Persisted accruedInterest remains untouched until a payment is posted.
    balance: outstandingBalance,
    outstandingBalance,
    repaid: Math.max(Number(loan.amount || 0) - Number(loan.principalBalance ?? loan.amount ?? 0), 0),
    interestRate: Number(loan.interestRate || 0),
    duration: Number(loan.duration || 0),
    nextPaymentDueAt: loan.nextPaymentDueAt,
    lastInterestAccrualAt: loan.lastInterestAccrualAt,
    autoApproved: loan.type === 'EMERGENCY' && loan.status === 'APPROVED',
    auditTimestamp: loan.decidedAt,
    status: loan.status,
    reason: loan.reason,
    purpose: loan.reason,
    approvedAt: loan.updatedAt,
    createdAt: loan.createdAt,
    selfGuaranteed: loan.selfGuaranteed,
    selfGuaranteedAmount: loan.selfGuaranteedAmount,
    guarantors: (loan.Guarantors || []).map((guarantor) => ({
      id: guarantor.id,
      memberId: guarantor.memberId,
      amount: guarantor.amount,
      status: guarantor.status,
      name: guarantor.Member?.User?.name
        || [guarantor.Member?.User?.firstName, guarantor.Member?.User?.lastName].filter(Boolean).join(' ')
        || guarantor.Member?.memberNumber
        || null,
      memberName: guarantor.Member?.User?.name
        || [guarantor.Member?.User?.firstName, guarantor.Member?.User?.lastName].filter(Boolean).join(' ')
        || null,
      memberNumber: guarantor.Member?.memberNumber || null,
      Member: guarantor.Member,
    })),
    repayments: (loan.loanTransactions || []).map((repayment) => {
      const metadata = repayment.metadata || {};
      const paymentDate = new Date(repayment.createdAt);
      const loanStart = new Date(loan.decidedAt || loan.createdAt);
      const elapsedMonths = Math.max(0,
        (paymentDate.getUTCFullYear() - loanStart.getUTCFullYear()) * 12
        + paymentDate.getUTCMonth() - loanStart.getUTCMonth());
      const durationRemaining = Number(metadata.remaining_installments
        ?? Math.max(Number(loan.duration || 0) - elapsedMonths, 0));
      const remainingInterest = Number(metadata.remaining_interest || 0);
      const remainingPrincipal = Number(repayment.remainingPrincipal || 0);
      return {
        id: repayment.id,
        ledgerTransactionId: repayment.ledgerTransactionId,
        amountPaid: Number(repayment.amount || 0),
        principalPaid: Number(repayment.principalPaid || 0),
        interestPaid: Number(repayment.interestPaid || 0),
        remainingPrincipal,
        remainingInterest,
        remainingAmount: Number(metadata.remaining_balance ?? (remainingPrincipal + remainingInterest)),
        durationRemaining,
        accruedDays: Number(repayment.accruedDays || 0),
        reference: metadata.receipt || null,
        paidAt: repayment.createdAt,
      };
    }),
    });
  });

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
  const payoutDestination = validateLoanPayoutDestination(req.body.payoutDestination);
  const guarantors = Array.isArray(req.body.guarantors) ? req.body.guarantors : [];
  await otpService.verifyOtp({ userId: req.user.id, purpose: 'LOAN_PAYOUT', otp: req.body.payoutDestination?.otp });
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

  const reason = [req.body.reason || req.body.purpose || '', buildPayoutReasonNote(payoutDestination)]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join('\n\n');

  const result = await loanService.createLoan({
    ...req.body,
    reason,
    payoutDestination,
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

  // Fetch pending M-Pesa rows too, so a callback/provider confirmation can be
  // reconciled before the member's balance and transaction history are built.
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

  const visibleTransactions = transactions.filter((transaction) => (
    ['SUCCESS', 'PAID', 'COMPLETED'].includes(String(transaction.status || '').toUpperCase())
    && String(transaction.type || '').toUpperCase() !== 'MEMBERSHIP_FEE'
    && !String(transaction.paymentCategory || '').toLowerCase().includes('registration')
    && !String(transaction.description || '').toLowerCase().includes('membership')
  ));

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
    phoneNumber: req.user.phone || null,
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

const serializeFinancialReportRow = (row) => ({
  id: row.id,
  year: row.year,
  category: row.category,
  amount: Number(row.amount || 0),
  percentageUsed: Number(row.percentageUsed || 0),
  metadata: row.metadata || {},
});

const getFinancialPortfolio = asyncHandler(async (req, res) => {
  const year = Number(req.query.year || new Date().getFullYear() - 1);
  if (!Number.isInteger(year) || year < 2000 || year > new Date().getFullYear() + 1) {
    throw new ValidationError('Enter a valid financial year');
  }

  const reports = await db.FinancialYearReport.findAll({
    where: { year, category: { [Op.ne]: '__YEAR__' } },
    order: [['category', 'ASC']],
  });
  const anchor = await db.FinancialYearReport.findOne({ where: { year, category: '__YEAR__' } });
  const dividend = anchor ? await db.MemberDividend.findOne({
    where: { userId: req.user.id, financialYearId: anchor.id },
  }) : null;
  const member = await findMemberByUserId(req.user.id);
  const shareAccount = member ? await db.ShareAccount.findOne({ where: { memberId: member.id } }) : null;

  const metrics = anchor?.metadata?.metrics || {};
  return ResponseHandler.success(res, {
    year,
    portfolio: {
      id: anchor?.id || null,
      year,
      metrics: {
        totalAmount: Number(metrics.totalAmount || 0),
        interestEarned: Number(metrics.interestEarned || 0),
        investments: Number(metrics.investments || 0),
        memberGrowthRate: Number(metrics.memberGrowthRate || 0),
      },
      chartData: Array.isArray(anchor?.metadata?.chartData) ? anchor.metadata.chartData : [],
      imageUrl: anchor?.metadata?.imageUrl || '',
      bannerUrl: anchor?.metadata?.bannerUrl || anchor?.metadata?.imageUrl || '',
      updatedAt: anchor?.updatedAt || null,
    },
    reports: reports.map(serializeFinancialReportRow),
    investmentCategories: reports.map(serializeFinancialReportRow),
    dividend: dividend ? {
      id: dividend.id,
      totalShares: Number(dividend.totalShares || 0),
      dividendPaid: Number(dividend.dividendPaid || 0),
      updatedAt: dividend.updatedAt,
    } : {
      totalShares: Number(shareAccount?.shares || 0),
      dividendPaid: 0,
      updatedAt: null,
    },
  }, 'Financial portfolio retrieved', 200);
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
  const phone = normalizeMpesaPhone(req.body.phone);
  const outstanding = calculateCurrentOutstandingBalance(loan);
  const maxStkAmount = Math.ceil(outstanding);
  if (!Number.isInteger(amount) || amount <= 0 || amount > maxStkAmount) throw new ValidationError(`Enter a whole-shilling amount between KES 1 and KES ${maxStkAmount}`);
  if (!isValidMpesaPhone(phone)) throw new ValidationError('Enter a valid Kenyan M-Pesa phone number');

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
      signal: AbortSignal.timeout(LOAN_REPAYMENT_STK_TIMEOUT_MS),
      body: JSON.stringify({
        phone, amount: Math.round(amount), accountReference: memberAccountReference,
        AccountReference: memberAccountReference, transactionDesc: `Loan repayment - ${memberAccountReference}`,
        TransactionDesc: `Loan repayment - ${memberAccountReference}`, loanId: loan.id, memberId: member.id,
        member_number: memberAccountReference,
        type: 'LOAN_REPAYMENT', method: 'MPESA', paymentCategory: 'loan_repayment', internalReference,
        callbackUrl: getBackendCallbackUrl(req),
        CallBackURL: getBackendCallbackUrl(req),
      }),
    });
    const text = await upstream.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text || 'M-Pesa returned an invalid response' };
    }
    const checkoutRequestId = payload.checkoutRequestId || payload.CheckoutRequestID;
    if (!upstream.ok || !checkoutRequestId) {
      logger.warn('Loan repayment STK upstream failed', {
        module: 'member',
        status: upstream.status,
        loanId: loan.id,
        transactionId: ledger.id,
        payload,
      });
    }
    if (!upstream.ok || !checkoutRequestId) throw new Error(payload.message || payload.error || 'M-Pesa did not return a checkout request ID');
    await ledger.update({ checkoutRequestId, merchantRequestId: payload.merchantRequestId || payload.MerchantRequestID || null, reference: checkoutRequestId });
    return ResponseHandler.success(res, { transactionId: ledger.id, checkoutRequestId, merchantRequestId: ledger.merchantRequestId, status: 'PENDING' }, 'STK Push Sent!', 200);
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    if (shouldUseLocalStkFallback()) {
      const checkoutRequestId = `LOCAL-STK-${Date.now()}`;
      await ledger.update({
        status: 'PENDING',
        checkoutRequestId,
        merchantRequestId: `LOCAL-${ledger.id}`,
        reference: checkoutRequestId,
        description: `Local pending STK fallback: ${error.message}`,
      });
      logger.warn('Using local STK fallback for loan repayment', {
        module: 'member',
        loanId: loan.id,
        transactionId: ledger.id,
        error: error.message,
      });
      return ResponseHandler.success(res, {
        transactionId: ledger.id,
        checkoutRequestId,
        merchantRequestId: ledger.merchantRequestId,
        status: 'PENDING',
        fallback: true,
      }, 'STK request recorded. M-Pesa worker is unavailable locally; complete via Paybill or retry when STK is online.', 200);
    }
    await ledger.update({
      status: timedOut ? 'PENDING' : 'FAILED',
      description: timedOut
        ? 'M-Pesa STK initiation timed out before a checkout request was returned'
        : error.message,
    });
    throw new ValidationError(timedOut
      ? 'M-Pesa is taking longer than expected to send the PIN prompt. Please wait a moment and check your phone before retrying.'
      : error.message || 'Unable to send M-Pesa PIN prompt');
  }
});

const getLoanPaymentStatus = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  let ledger = member ? await db.Transaction.findOne({ where: { memberId: member.id, checkoutRequestId: req.params.checkoutRequestId, type: 'LOAN_REPAYMENT' } }) : null;
  if (!ledger) throw new NotFoundError('Payment request not found');
  let repayment = await db.LoanTransaction.findOne({ where: { ledgerTransactionId: ledger.id } });
  if (String(ledger.status || '').toUpperCase() === 'PENDING' && !repayment) {
    const providerTransaction = await getProviderTransaction(ledger).catch((error) => {
      logger.warn('Loan repayment provider status lookup failed', {
        module: 'member',
        transactionId: ledger.id,
        checkoutRequestId: ledger.checkoutRequestId,
        error: error.message,
      });
      return null;
    });
    if (String(providerTransaction?.status || '').toUpperCase() === 'SUCCESS') {
      const receipt = providerTransaction.reference || providerTransaction.mpesaReceiptNumber || null;
      await allocateMpesaRepayment({
        ledgerTransactionId: ledger.id,
        receipt,
        confirmedAmount: providerTransaction.amount,
        resultDescription: providerTransaction.description || 'M-Pesa loan repayment received',
      });
      ledger = await db.Transaction.findByPk(ledger.id);
      repayment = await db.LoanTransaction.findOne({ where: { ledgerTransactionId: ledger.id } });
    } else if (String(providerTransaction?.status || '').toUpperCase() === 'FAILED') {
      await ledger.update({
        status: 'FAILED',
        description: providerTransaction.description || 'M-Pesa repayment failed',
      });
    }
  }
  const loan = ledger.loanId ? await db.Loan.findByPk(ledger.loanId) : null;
  const remainingBalance = repayment
    ? Number(repayment.remainingPrincipal) + Number(repayment.metadata?.remaining_interest || 0)
    : loan
      ? Number(loan.principalBalance ?? loan.amount ?? 0) + Number(loan.accruedInterest || 0)
      : null;
  return ResponseHandler.success(res, {
    checkoutRequestId: ledger.checkoutRequestId, status: ledger.status,
    mpesaReceiptNumber: ledger.status === 'SUCCESS' ? ledger.reference : null,
    principalPaid: repayment ? Number(repayment.principalPaid) : null,
    interestPaid: repayment ? Number(repayment.interestPaid) : null,
    remainingPrincipal: loan ? Number(loan.principalBalance ?? loan.amount ?? 0) : repayment ? Number(repayment.remainingPrincipal) : null,
    remainingInterest: loan ? Number(loan.accruedInterest || 0) : repayment ? Number(repayment.metadata?.remaining_interest || 0) : null,
    remainingBalance,
    nextPaymentDueAt: loan?.nextPaymentDueAt || null,
    loanStatus: loan?.status || null,
  }, 'Payment status retrieved');
});

const depositSavings = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Deposit amount is required');
  }

  const result = await db.sequelize.transaction(async (dbTransaction) => {
    const [savingsAccount] = await db.SavingsAccount.findOrCreate({
      where: { memberId: member.id },
      defaults: { balance: 0 },
      transaction: dbTransaction,
    });
    const transaction = await db.Transaction.create({
      memberId: member.id,
      type: 'DEPOSIT',
      amount,
      method: req.body.method || 'MANUAL',
      status: 'SUCCESS',
      reference: req.body.reference || `DEP-${Date.now()}`,
      description: req.body.description || 'Savings deposit',
      paymentCategory: req.body.paymentCategory || 'savings',
    }, { transaction: dbTransaction });
    await savingsAccount.update({
      balance: Number(savingsAccount.balance || 0) + amount,
    }, { transaction: dbTransaction });
    return { transaction, balance: Number(savingsAccount.balance || 0) + amount };
  });

  return ResponseHandler.created(res, {
    ...TransactionDTO.basic({
      id: result.transaction.id,
      type: result.transaction.type,
      amount: result.transaction.amount,
      description: buildTransactionDescription(result.transaction),
      createdAt: result.transaction.createdAt,
      status: result.transaction.status,
      method: result.transaction.method,
      reference: result.transaction.reference,
      mpesaReference: result.transaction.method === 'MPESA' ? result.transaction.reference : null,
    }),
    savingsBalance: result.balance,
  }, 'Savings deposit recorded successfully');
   
});

const initiateContribution = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Contribution amount is required');
  }

  const phone = normalizeMpesaPhone(req.body?.phone || req.user.phone);
  const paymentMode = String(req.body?.paymentMode || 'STK').toUpperCase();
  const contributionType = req.body?.contributionType || 'monthly';
  const promptType = getKcbPromptType(contributionType);
  const reference = `CONTRIB-${Date.now()}`;
  const memberNumber = member.memberNumber || reference;
  const memberPaymentAccount = /^29903-\d+$/i.test(String(memberNumber || ''))
    ? memberNumber
    : String(memberNumber || '').trim();

  if (paymentMode === 'STK' && !isValidMpesaPhone(phone)) {
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
  const member = await findMemberByUserId(req.user.id);
  const isStaffMember = Boolean(String(user.staffId || user.payrollNumber || '').trim())
    || String(user.employmentTag || '').toUpperCase() === 'EMPLOYEE'
    || String(user.role || '').toUpperCase() === 'EMPLOYEE';
  if (!isStaffMember && reportType === 'payroll-deduction') {
    throw new ForbiddenError('Payroll deduction reports are available to staff members only');
  }
  const dateFilter = durationMonths > 0 ? { createdAt: { [Op.gte]: new Date(new Date().setMonth(new Date().getMonth() - durationMonths)) } } : {};
  const transactions = member
    ? await db.Transaction.findAll({
      where: {
        memberId: member.id,
        ...dateFilter,
        status: { [Op.in]: ['SUCCESS', 'PAID', 'COMPLETED'] },
      },
      order: [['createdAt', 'DESC']],
    })
    : [];
  const loans = member
    ? await db.Loan.findAll({
      where: { memberId: member.id, ...(reportType === 'loans' ? dateFilter : {}) },
      include: [{
        model: db.Guarantor,
        include: [{
          model: db.Member,
          include: [db.User],
        }],
      }, {
        model: db.LoanTransaction,
        as: 'loanTransactions',
        separate: true,
        where: dateFilter,
        required: false,
        order: [['createdAt', 'DESC']],
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
  const signedCategoryTotal = (tokens) => successfulTransactions.reduce((sum, transaction) => {
    const category = getCategory(transaction);
    if (!tokens.some((token) => category.includes(token))) return sum;
    const outgoing = String(transaction.type || '').toUpperCase().includes('WITHDRAW')
      || category.includes('withdraw') || category.includes('disbursement');
    return sum + (outgoing ? -Number(transaction.amount || 0) : Number(transaction.amount || 0));
  }, 0);
  const paidShareCapital = signedCategoryTotal(['share_capital', 'sharecapital', 'share capital']);
  const shareAccountCapital = shares.reduce((sum, share) => sum + Number((share.shares || 0) * (share.shareValue || 0)), 0);
  const storedMemberShareCapital = Number(member?.shareCapital || 0);
  const shareCapital = Math.max(shareAccountCapital, storedMemberShareCapital, paidShareCapital, 0);
  const savingsTotal = Math.max(signedCategoryTotal(['savings']), 0);
  const activeLoans = loans.filter((loan) => (
    ['APPROVED', 'ACTIVE', 'DISBURSED', 'OVERDUE'].includes(String(loan.status || '').toUpperCase())
  ));
  const outstandingLoans = activeLoans
    .reduce((sum, loan) => sum + Number(calculateLoanBalanceQuote(loan).outstandingBalance || 0), 0);
  const transactionTotal = successfulTransactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const durationLabel = durationMonths > 0 ? `Last ${durationMonths} month${durationMonths === 1 ? '' : 's'}` : 'All records';
  const memberNumber = member?.memberNumber || user.memberNumber || 'Member';
  const reportName = reportNames[reportType] || 'Portfolio Report';
  const shareTransferRows = member && ['savings', 'shares-savings', 'portfolio'].includes(reportType)
    ? (await shareCapitalTransferService.historyForMember(member.id))
      .filter((transfer) => durationMonths <= 0 || new Date(transfer.createdAt) >= new Date(new Date().setMonth(new Date().getMonth() - durationMonths)))
      .filter((transfer) => String(transfer.status || 'SUCCESS').toUpperCase() === 'SUCCESS')
      .map((transfer) => ({
        id: transfer.id,
        type: 'SHARE_CAPITAL_TRANSFER',
        paymentCategory: 'share_capital_transfer',
        amount: Number(transfer.grossAmount || 0),
        netAmount: Number(transfer.netAmount || 0),
        direction: transfer.senderMemberId === member.id ? 'OUT' : 'IN',
        status: transfer.status || 'SUCCESS',
        reference: transfer.reference,
        createdAt: transfer.createdAt,
        description: transfer.senderMemberId === member.id ? 'Share capital transferred out' : 'Share capital received',
      }))
    : [];
  const transactionsWithPhone = successfulTransactions.map((transaction) => ({
    ...transaction.get({ plain: true }),
    phoneNumber: user.phone || null,
  })).concat(shareTransferRows)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const sections = buildReportSections({ reportType, transactions: transactionsWithPhone, loans, shares });
  const portfolioSummaryRows = [
    ['Share capital', `KES ${formatMoney(shareCapital)}`],
    ['Savings', `KES ${formatMoney(savingsTotal)}`],
    ['Outstanding loans', `KES ${formatMoney(outstandingLoans)}`],
    ['Successful transaction total', `KES ${formatMoney(transactionTotal)}`],
    ['Active loans', activeLoans.length],
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
  getWalletCashOutSummary,
  sendCashOutOtp,
  sendLoanPayoutOtp,
  cashOutWallet,
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
  searchOptOutTransferees,
  sendOptOutOtp,
  getGuarantees,
  getFinancialPortfolio,
  emailReport,
};
