/**
 * SECURE DATA TRANSFER OBJECTS (DTOs)
 * Sanitize and control data exposure to prevent sensitive information leaks
 */

const logger = require('./logger');

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

  const sanitized = { ...data };

  // Remove sensitive fields
  SENSITIVE_FIELDS.forEach(field => {
    delete sanitized[field];
  });

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
      idDocumentUrl: user.idDocumentUrl,
      passportPhotoUrl: user.passportPhotoUrl,
      role: user.role,
      isVerified: user.isVerified,
      consentGiven: user.consentGiven,
      consentGivenAt: user.consentGivenAt,
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
      status: transaction.status,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt
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

    const baseData = sanitizeBase({
      id: loan.id,
      memberId: loan.memberId,
      amount: loan.amount,
      interestRate: loan.interestRate,
      term: loan.term,
      status: loan.status,
      purpose: loan.purpose,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt
    });

    // Add financial details for authorized users
    if (requestingUser && ['ADMIN', 'SUPERADMIN', 'FINANCE'].includes(requestingUser.role)) {
      Object.assign(baseData, {
        approvedAmount: loan.approvedAmount,
        disbursedAmount: loan.disbursedAmount,
        outstandingBalance: loan.outstandingBalance,
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
  sanitizeModel,
  sanitizeModels,
  SENSITIVE_FIELDS,
  FINANCIAL_FIELDS
};