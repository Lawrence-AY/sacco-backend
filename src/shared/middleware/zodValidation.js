const { z } = require('zod');
const { ValidationError } = require('../utils/errors');

const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source] || {});
  if (!result.success) {
    const details = result.error.flatten();
    return next(new ValidationError('Validation failed', details.fieldErrors));
  }

  req[source] = result.data;
  return next();
};

const strictObject = (shape) => z.object(shape).strict();
const optionalEmptyableString = (max) => z.string().trim().max(max).optional().or(z.literal(''));
const optionalNullableString = (max) => z.string().trim().max(max).optional().nullable().transform((value) => value ?? undefined);
const dataImageUrl = z.string().trim().regex(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i);
const profilePhotoDataUrl = dataImageUrl.max(2200000);
const fixedGroupLoanInterestRate = z.coerce.number().refine((value) => value === 1, {
  message: 'Group loan interest rate is fixed at 1% per month',
}).optional();

const schemas = {
  login: strictObject({
    email: z.string().trim().min(3).max(120).toLowerCase(),
    password: z.string().min(1).max(128),
  }),
  register: strictObject({
    firstName: z.string().trim().min(1).max(50),
    lastName: z.string().trim().min(1).max(50),
    name: z.string().trim().max(120).optional(),
    email: z.string().trim().email().toLowerCase(),
    phone: z.string().trim().max(20).optional(),
    password: z.string().min(8).max(128),
    applicationId: z.string().uuid().optional(),
    role: z.string().trim().max(30).optional(),
  }),
  otp: strictObject({
    email: z.string().trim().min(3).max(120).toLowerCase(),
    otp: z.string().trim().regex(/^\d{6,8}$/),
  }),
  emailOnly: strictObject({
    email: z.string().trim().email().toLowerCase(),
  }),
  refresh: strictObject({
    refreshToken: z.string().min(1).optional(),
  }),
  forgotPassword: strictObject({
    email: z.string().trim().email().toLowerCase(),
  }),
  resetPassword: strictObject({
    token: z.string().trim().min(32).max(256),
    newPassword: z.string().min(8).max(128),
  }),
  changePassword: strictObject({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
  }),
  profileUpdate: strictObject({
    firstName: z.string().trim().min(1).max(50).optional(),
    lastName: z.string().trim().min(1).max(50).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    phone: z.string().trim().max(20).optional(),
    nationalId: z.string().trim().max(20).optional(),
    kraPin: optionalNullableString(20),
    occupation: z.string().trim().max(100).optional(),
    address: z.string().trim().max(255).optional(),
    poBox: optionalNullableString(100),
    county: optionalNullableString(100),
    subCounty: optionalNullableString(100),
    dateOfBirth: optionalEmptyableString(20),
    gender: optionalEmptyableString(40),
    employer: optionalEmptyableString(120),
    monthlyIncome: z.coerce.number().nonnegative().max(100000000).optional().or(z.literal('')),
    payrollNumber: optionalEmptyableString(60),
    passportPhotoUrl: z.string().trim().url().max(2048).optional().or(dataImageUrl.max(2200000)).or(z.literal('')),
    consentGiven: z.boolean().optional(),
    consentGivenAt: z.string().trim().max(64).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
    nominees: z.array(strictObject({
      fullName: optionalEmptyableString(120),
      relationship: optionalEmptyableString(80),
      phone: optionalEmptyableString(30),
      nationalId: z.string().trim().max(30).optional().or(z.literal('')),
      allocationPercentage: z.coerce.number().min(0).max(100).optional().or(z.literal('')),
    })).max(3).optional(),
  }),
  profilePhotoUpload: strictObject({
    photo: profilePhotoDataUrl,
  }),
  kycDocumentsUpload: strictObject({
    identityType: z.enum(['national', 'passport']).optional(),
    front: z.string().trim().startsWith('data:').max(7000000),
    back: z.string().trim().startsWith('data:').max(7000000).optional(),
  }).refine((data) => data.identityType === 'passport' || Boolean(data.back), {
    message: 'Document back is required for National ID uploads',
    path: ['back'],
  }),
  identityVerification: strictObject({
    email: z.string().trim().email().toLowerCase().optional(),
    firstName: z.string().trim().min(1).max(50),
    surname: z.string().trim().min(1).max(50),
    documentType: z.enum(['national', 'passport', 'NATIONAL', 'PASSPORT']).optional(),
    identityType: z.enum(['national', 'passport', 'NATIONAL', 'PASSPORT']).optional(),
    idType: z.enum(['national', 'passport']).optional(),
    idNumber: z.string().trim().max(30).optional(),
    identityNumber: z.string().trim().max(30).optional(),
    nationalId: z.string().trim().max(30).optional(),
    passportNumber: z.string().trim().max(30).optional(),
  }).refine((data) => Boolean(data.idNumber || data.identityNumber || data.nationalId || data.passportNumber), {
    message: 'Document number is required',
    path: ['idNumber'],
  }),
  roleUpdate: strictObject({
    role: z.enum(['MEMBER', 'EMPLOYEE', 'FINANCE', 'ADMIN', 'SUPERADMIN', 'member', 'employee', 'finance', 'admin', 'superadmin'])
      .transform((role) => role.toUpperCase()),
  }),
  statusUpdate: strictObject({
    active: z.boolean(),
  }),
  loanRequest: strictObject({
    amount: z.coerce.number().positive().max(10000000),
    type: z.string().trim().min(1).max(50),
    duration: z.coerce.number().int().positive().max(120).optional(),
    interestRate: z.coerce.number().min(0).max(100).optional(),
    reason: z.string().trim().max(500).optional(),
    purpose: z.string().trim().max(500).optional(),
    selfGuarantee: z.boolean().optional().default(false),
    selfGuaranteedAmount: z.coerce.number().positive().max(10000000).optional(),
    guarantors: z.array(strictObject({
      memberId: z.string().uuid(),
      amount: z.coerce.number().positive(),
    })).max(10).optional(),
  }),
  transaction: strictObject({
    memberId: z.string().uuid().optional(),
    amount: z.coerce.number().positive().max(100000000),
    type: z.string().trim().min(1).max(50),
    method: z.string().trim().max(50).optional(),
    reference: z.string().trim().max(120).optional(),
    description: z.string().trim().max(255).optional(),
    paymentCategory: z.string().trim().max(80).optional(),
    kcbEndpoint: z.string().trim().max(80).optional(),
    internalReference: z.string().trim().max(120).optional(),
    promptChannel: z.string().trim().max(50).optional(),
  }),
  moneyAction: strictObject({
    amount: z.coerce.number().positive().max(100000000),
    method: z.string().trim().max(50).optional(),
    reference: z.string().trim().max(120).optional(),
  }),
  sharesPurchase: strictObject({
    shares: z.coerce.number().positive().max(1000000).optional(),
    amount: z.coerce.number().positive().max(100000000).optional(),
  }).refine((data) => data.shares !== undefined || data.amount !== undefined, {
    message: 'shares or amount is required',
  }),
  search: strictObject({
    q: z.string().trim().min(2).max(100),
    page: z.coerce.number().int().positive().max(1000).default(1),
    limit: z.coerce.number().int().positive().max(50).default(10),
    sortBy: z.enum(['createdAt', 'updatedAt', 'name', 'amount', 'status']).default('createdAt'),
    sortOrder: z.enum(['ASC', 'DESC', 'asc', 'desc']).default('DESC').transform((value) => value.toUpperCase()),
    type: z.enum([
      'all',
      'members',
      'transactions',
      'loans',
      'applications',
      'savingsAccounts',
      'shareAccounts',
      'dividends',
      'salaryDeductions',
    ]).default('all'),
    status: z.string().trim().max(40).optional(),
  }),
  reportRequest: strictObject({
    reportType: z.enum([
      'portfolio',
      'transactions',
      'loans',
      'savings',
      'shares-savings',
      'withdrawals',
      'loan-repayment',
      'guarantor',
      'payroll-deduction',
    ]).default('portfolio'),
    duration: z.coerce.number().int().positive().max(120).optional(),
  }),
  memberOptOutRequest: strictObject({
    reason: z.string().trim().min(1, 'Reason for leaving is required').max(1000),
    buyerMemberNumber: z.string().trim().max(60).optional().or(z.literal('')),
    transfereeInfo: z.string().trim().max(1500).optional().or(z.literal('')),
    transfereeMemberId: z.string().uuid().optional(),
    transferAmount: z.coerce.number().positive().max(100000000).optional(),
    uploadedFormName: z.string().trim().max(255).optional().or(z.literal('')),
    uploadedFormDataUrl: z.string().trim().max(8000000).optional().or(z.literal('')),
    otp: z.string().trim().regex(/^\d{6,8}$/, 'Enter the OTP sent to your email and phone'),
    acknowledgedTerms: z.boolean().refine((value) => value === true, {
      message: 'You must acknowledge the opt-out terms',
    }),
  }),
  shareCapitalTransfer: strictObject({
    recipientMemberNumber: z.string().trim().min(1).max(60),
    amount: z.coerce.number().positive().max(100000000),
    optOut: z.boolean().optional().default(false),
    confirmed: z.boolean().refine((value) => value === true, { message: 'Transfer confirmation is required' }),
  }),
  groupCreate: strictObject({
    name: z.string().trim().min(3).max(120),
    description: z.string().trim().max(500).optional().or(z.literal('')),
  }),
  groupInvitation: strictObject({ memberNumber: z.string().trim().min(1).max(60) }),
  groupInvitationResponse: strictObject({ accept: z.boolean() }),
  groupLoan: strictObject({
    amount: z.coerce.number().positive().max(100000000),
    paymentPeriodMonths: z.coerce.number().int().positive().max(120),
    interestRate: fixedGroupLoanInterestRate,
  }),
  groupLoanProposal: strictObject({
    totalAmount: z.coerce.number().positive().max(100000000),
    durationMonths: z.coerce.number().int().positive().max(120),
    interestRate: fixedGroupLoanInterestRate,
    allocations: z.array(strictObject({
      memberId: z.string().uuid(),
      allocatedPercentage: z.coerce.number().positive().max(100),
    })).min(1),
  }),
  groupProposalVote: strictObject({ accept: z.boolean() }),
};

module.exports = {
  validate,
  schemas,
};
