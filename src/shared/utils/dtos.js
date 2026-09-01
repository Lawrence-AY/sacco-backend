/**
 * SECURE DATA TRANSFER OBJECTS (DTOs)
 * Sanitize and control data exposure to prevent sensitive information leaks
 */

const logger = require('./logger');
const { formatEAT } = require('./eatDateTime');
const { calculateCurrentOutstandingBalance } = require('../../features/loans/services/loanCalculationEngine');

// Sensitive fields that should NEVER be exposed in API responses
const SENSITIVE_FIELDS = [
  'password',
  'otp',
  'otpExpiresAt',
  'passwordResetToken',
  'passwordResetExpires',
  'sessionToken',
  'refreshToken',
  'internalNotes',
  'adminNotes',
  'auditLog'
];

// Financial fields that require specific role access
const FINANCIAL_FIELDS = [
  'balance',
  'accountNumber',
  'transactionAmount',
  'loanAmount',
  'interestRate',
  'paymentSchedule'
];

/**
 * Base DTO sanitizer - removes all sensitive fields
 */
const sanitizeBase = (data) => {
  if (!data) return null;

  const source = typeof data.toJSON === 'function' ? data.toJSON() : data;
  const sanitized = { ...source };

  // Remove sensitive fields
  SENSITIVE_FIELDS.forEach(field => {
    delete sanitized[field];
  });

  return sanitized;
};

const sanitizeMemberForPrivateProfile = (member) => {
  if (!member) return null;
  const source = typeof member.toJSON === 'function' ? member.toJSON() : member;
  const sanitized = sanitizeBase(source);
  if (sanitized?.importProfile?.raw) {
    const raw = { ...sanitized.importProfile.raw };
    Object.keys(raw).forEach((key) => {
      if (String(key).toLowerCase().replace(/[^a-z0-9]/g, '').includes('membershipfee')) {
        delete raw[key];
      }
    });
    sanitized.importProfile = { ...sanitized.importProfile, raw };
  }
  if (sanitized?.importProfile) {
    delete sanitized.importProfile.membershipFee;
  }
  delete sanitized.membershipFee;
  return sanitized;
};

/**
 * User DTO - controls what user data is exposed based on context
 */
const UserDTO = {
  // Public profile (visible to anyone)
  public: (user) => {
    if (!user) return null;

    return sanitizeBase({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
      phone: user.phone,
      passportPhotoUrl: user.passportPhotoUrl,
      role: user.role,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
  },

  // Private profile (visible to user themselves and admins)
  private: (user) => {
    if (!user) return null;

    return sanitizeBase({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      email: user.email,
      phone: user.phone,
      nationalId: user.nationalId,
      kraPin: user.kraPin,
      occupation: user.occupation,
      address: user.address,
      poBox: user.poBox,
      county: user.county,
      subCounty: user.subCounty,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      employer: user.employer,
      company: user.employer,
      staffId: user.staffId,
      employmentTag: user.employmentTag,
      isWhitelisted: user.isWhitelisted,
      mustChangePassword: user.mustChangePassword,
      employerContribution: user.employerContribution,
      monthlyIncome: user.monthlyIncome,
      payrollNumber: user.payrollNumber,
      idDocumentUrl: user.idDocumentUrl,
      passportPhotoUrl: user.passportPhotoUrl,
      role: user.role,
      isVerified: user.isVerified,
      consentGiven: user.consentGiven,
      consentGivenAt: user.consentGivenAt,
      Member: sanitizeMemberForPrivateProfile(user.Member || user.member || null),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
  },

  // Admin view (visible only to admins/superadmins)
  admin: (user) => {
    if (!user) return null;

    return sanitizeBase(user); // Admins can see everything except SENSITIVE_FIELDS
  }
};

/**
 * Member DTO with financial data access control
 */
const MemberDTO = {
  // Basic member info (visible to member themselves and authorized roles)
  basic: (member, requestingUser = null) => {
    if (!member) return null;

    const baseData = sanitizeBase({
      id: member.id,
      userId: member.userId,
      memberNumber: member.memberNumber,
      type: member.type,
      nationalId: member.nationalId,
      isVerified: member.isVerified,
      status: member.status,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt
    });

    // Add financial data only if user has permission
    if (requestingUser && ['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(requestingUser.role)) {
      // Add financial fields for authorized users
      const financialData = {};
      FINANCIAL_FIELDS.forEach(field => {
        if (member[field] !== undefined) {
          financialData[field] = member[field];
        }
      });
      Object.assign(baseData, financialData);
    }

    return baseData;
  },

  // Full member data (admin/superadmin only)
  full: (member) => {
    if (!member) return null;
    return sanitizeBase(member);
  }
};

/**
 * Transaction DTO with strict access control
 */
const TransactionDTO = {
  // Basic transaction info (visible to transaction owner and authorized roles)
  basic: (transaction, requestingUser = null) => {
    if (!transaction) return null;

    const baseData = sanitizeBase({
      id: transaction.id,
      memberId: transaction.memberId,
      type: transaction.type,
      amount: transaction.amount,
      description: transaction.description,
      paymentCategory: transaction.paymentCategory,
      kcbEndpoint: transaction.kcbEndpoint,
      internalReference: transaction.internalReference,
      promptChannel: transaction.promptChannel,
      status: transaction.status,
      createdAt: transaction.createdAt,
      createdAtEAT: formatEAT(transaction.createdAt),
      updatedAt: transaction.updatedAt,
      updatedAtEAT: formatEAT(transaction.updatedAt)
    });

    // Add sensitive financial details only for authorized users
    if (requestingUser && ['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(requestingUser.role)) {
      Object.assign(baseData, {
        reference: transaction.reference,
        balanceBefore: transaction.balanceBefore,
        balanceAfter: transaction.balanceAfter,
        processedBy: transaction.processedBy,
        processedAt: transaction.processedAt
      });
    }

    return baseData;
  },

  // Full transaction data (admin/superadmin only)
  full: (transaction) => {
    if (!transaction) return null;
    return sanitizeBase(transaction);
  }
};

/**
 * Loan DTO with financial protection
 */
const LoanDTO = {
  basic: (loan, requestingUser = null) => {
    if (!loan) return null;
    const outstandingBalance = calculateCurrentOutstandingBalance(loan);

    const baseData = sanitizeBase({
      id: loan.id,
      memberId: loan.memberId,
      amount: loan.amount,
      interestRate: loan.interestRate,
      duration: loan.duration,
      term: loan.term || loan.duration,
      status: loan.status,
      principalBalance: Number(loan.principalBalance ?? loan.amount ?? 0),
      accruedInterest: Number(loan.accruedInterest || 0),
      outstandingBalance,
      nextPaymentDueAt: loan.nextPaymentDueAt,
      lastInterestAccrualAt: loan.lastInterestAccrualAt,
      autoApproved: loan.type === 'EMERGENCY' && loan.status === 'APPROVED',
      auditTimestamp: loan.decidedAt,
      reason: loan.reason,
      purpose: loan.purpose || loan.reason,
      rejectionReason: loan.rejectionReason,
      decidedAt: loan.decidedAt,
      type: loan.type,
      approvalStage: loan.approvalStage,
      selfGuaranteed: loan.selfGuaranteed,
      selfGuaranteedAmount: loan.selfGuaranteedAmount,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt
    });

    // Add financial details for authorized users
    if (requestingUser && ['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(requestingUser.role)) {
      Object.assign(baseData, {
        approvedAmount: loan.approvedAmount,
        disbursedAmount: loan.disbursedAmount,
        outstandingBalance: Number(loan.principalBalance ?? loan.amount ?? 0) + Number(loan.accruedInterest || 0),
        nextPaymentDate: loan.nextPaymentDate,
        approvedBy: loan.approvedBy,
        approvedAt: loan.approvedAt
      });
    }

    return baseData;
  },

  full: (loan) => {
    if (!loan) return null;
    return sanitizeBase(loan);
  }
};

/**
 * Generic sanitizer for any model
 */
const sanitizeModel = (model, options = {}) => {
  const {
    requestingUser = null,
    fields = null, // Specific fields to include
    exclude = [], // Additional fields to exclude
    dto = null // Specific DTO to use
  } = options;

  if (!model) return null;

  let data = model;

  // Convert Sequelize instance to plain object
  if (typeof model.toJSON === 'function') {
    data = model.toJSON();
  }

  // Apply specific DTO if provided
  if (dto) {
    return dto(data, requestingUser);
  }

  // Apply base sanitization
  let sanitized = sanitizeBase(data);

  // Include only specific fields if requested
  if (fields && Array.isArray(fields)) {
    const filtered = {};
    fields.forEach(field => {
      if (sanitized[field] !== undefined) {
        filtered[field] = sanitized[field];
      }
    });
    sanitized = filtered;
  }

  // Exclude additional fields
  exclude.forEach(field => {
    delete sanitized[field];
  });

  return sanitized;
};

/**
 * Sanitize array of models
 */
const sanitizeModels = (models, options = {}) => {
  if (!Array.isArray(models)) return sanitizeModel(models, options);
  return models.map(model => sanitizeModel(model, options));
};

module.exports = {
  UserDTO,
  MemberDTO,
  TransactionDTO,
  LoanDTO,
  sanitizeMemberForPrivateProfile,
  sanitizeModel,
  sanitizeModels,
  SENSITIVE_FIELDS,
  FINANCIAL_FIELDS
};
