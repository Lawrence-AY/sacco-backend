const { Op } = require('sequelize');
const db = require('../../../models');
const iprs = require('../../../services/iprs');
const iprsConfig = require('../../../shared/config/iprs');
const notificationService = require('../../notifications/services/notificationService');

const MAX_ATTEMPTS = 3;
const BLOCK_REASON = 'Failed IPRS identity verification 3 times';
const ADMIN_REASON = 'IPRS identity mismatch (3 failed attempts)';

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const normalizeDocumentNumber = (value) => String(value || '').trim().toUpperCase();

const getOpenAttempt = async (email, transaction) => db.IdentityVerificationAttempt.findOne({
  where: {
    email,
    blockStatus: true,
    status: 'BLOCKED',
  },
  order: [['updatedAt', 'DESC']],
  transaction,
});

const countRecentFailures = async (email, transaction) => db.IdentityVerificationAttempt.count({
  where: {
    email,
    status: 'FAILED',
    blockStatus: false,
    resetAt: null,
  },
  transaction,
});

const createAuditLog = (payload, options = {}) => db.AuditLog.create({
  userId: payload.userId || null,
  action: payload.action || 'IPRS_VERIFICATION_FAILED',
  module: 'identity-verification',
  method: payload.method || 'POST',
  route: payload.route || '/api/applications/identity-verification',
  statusCode: payload.statusCode || 400,
  ip: payload.ipAddress,
  userAgent: payload.userAgent,
  metadata: {
    email: payload.email,
    documentNumber: payload.documentNumber,
    failureReason: payload.failureReason,
    timestamp: new Date().toISOString(),
    ipAddress: payload.ipAddress,
    attemptCount: payload.attemptCount,
  },
}, options);

async function verifyAndTrackIdentity({ user, email, idNumber, documentType, firstName, surname, ipAddress, userAgent }) {
  const normalizedEmail = normalizeEmail(email || user?.email);
  const documentNumber = normalizeDocumentNumber(idNumber);
  const type = iprs.normalizeDocumentType(documentType);

  if (!normalizedEmail || !documentNumber || !firstName || !surname) {
    const error = new Error('Email, document number, first name, and surname are required.');
    error.statusCode = 400;
    throw error;
  }

  const existingBlock = await getOpenAttempt(normalizedEmail);
  if (existingBlock) {
    return {
      success: false,
      blocked: true,
      attemptCount: existingBlock.attemptCount,
      attemptsRemaining: 0,
      message: 'This email is blocked after failed identity verification. Contact support for help.',
    };
  }

  const verification = await iprs.verifyIdentity({ idNumber: documentNumber, documentType: type, firstName, surname });

  if (verification.success) {
    await db.IdentityVerificationAttempt.create({
      userId: user?.id || null,
      email: normalizedEmail,
      documentType: type,
      documentNumber,
      firstName,
      surname,
      attemptCount: 0,
      status: 'VERIFIED',
      blockStatus: false,
      reason: verification.message,
      ipAddress,
    });
    return {
      success: true,
      blocked: false,
      attemptCount: 0,
      attemptsRemaining: MAX_ATTEMPTS,
      iprsEnabled: iprsConfig.enabled,
      message: verification.message,
    };
  }

  const failedAttempt = await db.sequelize.transaction(async (transaction) => {
    const previousFailures = await countRecentFailures(normalizedEmail, transaction);
    const attemptCount = Math.min(previousFailures + 1, MAX_ATTEMPTS);
    const blocked = attemptCount >= MAX_ATTEMPTS;
    const record = await db.IdentityVerificationAttempt.create({
      userId: user?.id || null,
      email: normalizedEmail,
      documentType: type,
      documentNumber,
      firstName,
      surname,
      attemptCount,
      status: blocked ? 'BLOCKED' : 'FAILED',
      blockStatus: blocked,
      reason: blocked ? BLOCK_REASON : verification.message,
      failureReason: verification.message,
      ipAddress,
      blockedAt: blocked ? new Date() : null,
    }, { transaction });

    if (user?.id && blocked) {
      await db.User.update({
        lockedUntil: new Date('9999-12-31T23:59:59.000Z'),
        isVerified: false,
      }, { where: { id: user.id }, transaction });
    }

    await createAuditLog({
      userId: user?.id || null,
      email: normalizedEmail,
      documentNumber,
      failureReason: verification.message,
      ipAddress,
      userAgent,
      attemptCount,
      action: blocked ? 'IPRS_IDENTITY_BLOCKED' : 'IPRS_VERIFICATION_FAILED',
      statusCode: blocked ? 423 : 400,
    }, { transaction });

    return record;
  });

  if (failedAttempt.blockStatus) {
    await notificationService.createAdminIdentityBlockNotifications({
      email: normalizedEmail,
      documentNumber,
      attemptCount: failedAttempt.attemptCount,
      reason: ADMIN_REASON,
      attemptId: failedAttempt.id,
    });
  }

  return {
    success: false,
    blocked: failedAttempt.blockStatus,
    attemptCount: failedAttempt.attemptCount,
    attemptsRemaining: Math.max(MAX_ATTEMPTS - failedAttempt.attemptCount, 0),
    message: failedAttempt.blockStatus
      ? 'This email has been blocked after 3 failed identity verification attempts. Contact support for help.'
      : `Details do not match official records. Attempt ${failedAttempt.attemptCount} of 3 before account lock.`,
  };
}

async function listBlockedAttempts() {
  const rows = await db.IdentityVerificationAttempt.findAll({
    where: {
      [Op.or]: [{ blockStatus: true }, { status: 'BLOCKED' }],
    },
    order: [['updatedAt', 'DESC']],
    limit: 250,
  });
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    email: row.email,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    timestamp: row.blockedAt || row.updatedAt || row.createdAt,
    attemptCount: row.attemptCount,
    blockStatus: row.blockStatus,
    reason: ADMIN_REASON,
    failureReason: row.failureReason,
  }));
}

async function unblockAttempt(id, adminUser) {
  const attempt = await db.IdentityVerificationAttempt.findByPk(id);
  if (!attempt) return null;
  const email = normalizeEmail(attempt.email);
  await db.sequelize.transaction(async (transaction) => {
    await db.IdentityVerificationAttempt.update({
      blockStatus: false,
      status: 'RESET',
      resetAt: new Date(),
      resetById: adminUser?.id || null,
      reason: 'Reset by admin',
    }, {
      where: { email, blockStatus: true },
      transaction,
    });
    await db.User.update({
      lockedUntil: null,
      failedLoginAttempts: 0,
    }, { where: { email }, transaction });
    await createAuditLog({
      userId: adminUser?.id,
      email,
      documentNumber: attempt.documentNumber,
      failureReason: 'Blocked IPRS verification reset by admin',
      ipAddress: null,
      userAgent: null,
      attemptCount: attempt.attemptCount,
      action: 'IPRS_IDENTITY_UNBLOCKED',
      statusCode: 200,
    }, { transaction });
  });
  return { id, email, blockStatus: false };
}

module.exports = {
  verifyAndTrackIdentity,
  listBlockedAttempts,
  unblockAttempt,
};
