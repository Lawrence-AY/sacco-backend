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
const dataImageUrl = z.string().trim().regex(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i);
const profilePhotoDataUrl = dataImageUrl.max(2200000);

const schemas = {
  login: strictObject({
    email: z.string().trim().email().toLowerCase(),
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
    email: z.string().trim().email().toLowerCase(),
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
  }),
  profileUpdate: strictObject({
    firstName: z.string().trim().min(1).max(50).optional(),
    lastName: z.string().trim().min(1).max(50).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    phone: z.string().trim().max(20).optional(),
    nationalId: z.string().trim().max(20).optional(),
    kraPin: z.string().trim().max(20).optional(),
    occupation: z.string().trim().max(100).optional(),
    address: z.string().trim().max(255).optional(),
    dateOfBirth: optionalEmptyableString(20),
    gender: optionalEmptyableString(40),
    employer: optionalEmptyableString(120),
    monthlyIncome: z.coerce.number().nonnegative().max(100000000).optional().or(z.literal('')),
    payrollNumber: optionalEmptyableString(60),
    nextOfKinName: optionalEmptyableString(120),
    nextOfKinRelationship: optionalEmptyableString(80),
    nextOfKinPhone: optionalEmptyableString(30),
    nextOfKin: strictObject({
      name: optionalEmptyableString(120),
      relationship: optionalEmptyableString(80),
      phone: optionalEmptyableString(30),
    }).optional(),
    passportPhotoUrl: z.string().trim().url().max(2048).optional().or(dataImageUrl.max(2200000)).or(z.literal('')),
    consentGiven: z.boolean().optional(),
    consentGivenAt: z.string().trim().max(64).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
  }),
  profilePhotoUpload: strictObject({
    photo: profilePhotoDataUrl,
  }),
  roleUpdate: strictObject({
    role: z.enum(['MEMBER', 'FINANCE', 'ADMIN', 'SUPERADMIN', 'member', 'finance', 'admin', 'superadmin'])
      .transform((role) => role.toUpperCase()),
  }),
  statusUpdate: strictObject({
    active: z.boolean(),
  }),
  loanRequest: strictObject({
    amount: z.coerce.number().positive().max(10000000),
    type: z.string().trim().min(1).max(50),
    duration: z.coerce.number().int().positive().max(120).optional(),
    purpose: z.string().trim().max(500).optional(),
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
};

module.exports = {
  validate,
  schemas,
};
