const express = require('express');
const db = require('../../models');
const logger = require('../../shared/utils/logger');
const { getFirebaseDb } = require('../../shared/config/firebase');
const { allocateMpesaRepayment } = require('../loans/services/loanRepaymentService');
const { isShareCapitalPayment, settleShareCapitalPayment } = require('../shares/services/shareCapitalPaymentService');
const eventBus = require('../../services/realtime/eventBus');
const { queuePaymentConfirmation } = require('../notifications/services/notificationService');
const { PAYBILL, parseAccountReference } = require('./mpesaReference');

const router = express.Router();
const MPESA_PROXY_TIMEOUT_MS = Number(process.env.MPESA_TIMEOUT_MS || 115000);
const KCB_PAYBILL_NUMBER = PAYBILL;
const KCB_PAYMENT_TYPES = {
  MS: { type: 'DEPOSIT', category: 'savings', description: 'KCB direct savings payment' },
  LM: { type: 'LOAN_REPAYMENT', category: 'emergency_loan_repayment', description: 'KCB emergency loan payment' },
  LE: { type: 'LOAN_REPAYMENT', category: 'education_loan_repayment', description: 'KCB education loan payment' },
  LW: { type: 'LOAN_REPAYMENT', category: 'welfare_loan_repayment', description: 'KCB welfare loan payment' },
  LD: { type: 'LOAN_REPAYMENT', category: 'development_loan_repayment', description: 'KCB development loan payment' },
  SC: { type: 'DEPOSIT', category: 'share_capital', description: 'KCB direct share capital payment' },
  PF: { type: 'DEPOSIT', category: 'processing_fee', description: 'KCB processing fee payment' },
  RF: { type: 'DEPOSIT', category: 'registration_fee', description: 'KCB registration fee payment' },
};
const KCB_LOAN_TYPES = { LM: 'EMERGENCY', LE: 'EDUCATION', LW: 'WELFARE', LD: 'DEVELOPMENT' };

const kcbIpnAuth = (req, res, next) => {
  const expected = String(process.env.KCB_IPN_SHARED_SECRET || '').trim();
  if (expected && req.get('x-kcb-ipn-secret') !== expected) return res.status(401).json({ statusCode: 1, statusMessage: 'Unauthorized' });
  next();
};

// KCB direct-payments endpoint. Registration fees remain in Firebase registrations;
// all other board-approved payment identifiers become member ledger transactions.
router.post('/kcb/ipn', kcbIpnAuth, async (req, res) => {
  const body = req.body || {};
  // KCB has used both camelCase and snake_case names across its IPN
  // environments. Keep the canonical account reference intact so the #
  // separator and the complete five-digit member suffix are never lost.
  const transactionReference = String(
    body.transactionReference
      || body.transaction_reference
      || body.transactionId
      || body.transaction_id
      || body.mpesaReceiptNumber
      || body.mpesa_receipt_number
      || body.receiptNumber
      || body.receipt_number
      || ''
  ).trim();
  const accountReference = String(
    body.customerReference
      || body.customer_reference
      || body.accountReference
      || body.account_reference
      || body.invoiceNumber
      || body.invoice_number
      || body.billReference
      || body.bill_reference
      || ''
  ).trim().toUpperCase();
  const narration = String(
    body.transactionDescription
      || body.transaction_description
      || body.narration
      || body.description
      || body.reference
      || ''
  ).toUpperCase();
  const metadataReference = narration.match(/7929884(?:#|-)?(MS|LM|LE|LW|LD|SC|RF|PF)\d{5}/i)?.[0] || '';
  const resolvedAccountReference = accountReference || metadataReference;
  const amount = Number(body.transactionAmount ?? body.transaction_amount ?? body.amount ?? body.paidAmount ?? body.paid_amount);
  const match = parseAccountReference(resolvedAccountReference);
  const promptedPhone = String(
    body.customerMobileNumber || body.customer_mobile_number || body.phoneNumber
      || body.phone_number || body.msisdn || body.mobileNumber || body.mobile_number || ''
  ).replace(/\D/g, '');
  if (!transactionReference || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ statusCode: 1, statusMessage: 'Invalid KCB payment reference or amount' });
  }

  // A direct paybill payment may contain only 7929884. In that case use the
  // phone number supplied by KCB to resolve the member and treat it as savings.
  const normalizedIdentifier = match?.designator || 'MS';
  const memberSequence = match?.memberSuffix || null;
  const payment = KCB_PAYMENT_TYPES[normalizedIdentifier];
  if (!payment || (!match && !promptedPhone)) {
    return res.status(400).json({ statusCode: 1, statusMessage: 'Member reference or payment phone is required' });
  }
  const existing = await db.Transaction.findOne({ where: { providerTransactionId: transactionReference } });
  if (existing) return res.json({ transactionID: transactionReference, statusCode: 0, statusMessage: 'Already processed' });

  if (normalizedIdentifier === 'RF') {
    const member = await db.Member.findOne({ where: { memberNumber: { [db.Sequelize.Op.like]: `%${memberSequence}` } } });
    await getFirebaseDb().collection('registrations').doc(transactionReference).set({
      transaction_reference: transactionReference, customer_reference: resolvedAccountReference,
      member_number: member?.memberNumber || memberSequence, member_id: member?.id || null, amount,
      transaction_amount: amount, status: 'completed', payment_category: 'registration',
      customer_name: body.customerName || null, customer_mobile_number: body.customerMobileNumber || null,
      created_at: new Date(), updated_at: new Date(),
    }, { merge: true });
    return res.json({ transactionID: transactionReference, statusCode: 0, statusMessage: 'Registration payment received' });
  }

  // Resolve by member suffix when supplied; otherwise resolve the direct
  // paybill payment by the phone number that KCB reported.
  let member = memberSequence
    ? await db.Member.findOne({ where: { memberNumber: { [db.Sequelize.Op.like]: `%${memberSequence}` } } })
    : null;
  if (!member && promptedPhone.length >= 9) {
    const phoneSuffix = promptedPhone.slice(-9);
    member = await db.Member.findOne({
      include: [{ model: db.User, where: { phone: { [db.Sequelize.Op.like]: `%${phoneSuffix}` } }, attributes: [] }],
    });
  }
  if (!member) return res.status(404).json({ statusCode: 1, statusMessage: 'Member not found' });

  let loanId = null;
  if (KCB_LOAN_TYPES[normalizedIdentifier]) {
    const loan = await db.Loan.findOne({
      where: { memberId: member.id, type: KCB_LOAN_TYPES[normalizedIdentifier], status: { [db.Sequelize.Op.in]: ['ACTIVE', 'APPROVED', 'DISBURSED'] } },
      order: [['createdAt', 'DESC']],
    });
    if (!loan) return res.status(404).json({ statusCode: 1, statusMessage: 'Active loan not found for payment designator' });
    loanId = loan.id;
  }

  const transaction = await db.sequelize.transaction(async (databaseTransaction) => {
    const created = await db.Transaction.create({
      memberId: member.id, loanId, type: payment.type, amount, method: 'MPESA', status: (KCB_LOAN_TYPES[normalizedIdentifier] || normalizedIdentifier === 'SC') ? 'PENDING' : 'SUCCESS',
      reference: transactionReference, providerTransactionId: transactionReference,
      internalReference: resolvedAccountReference, description: payment.description,
      paymentCategory: payment.category, kcbEndpoint: '/kcb/ipn',
    }, { transaction: databaseTransaction });
    if (normalizedIdentifier === 'MS') {
      const [account] = await db.SavingsAccount.findOrCreate({ where: { memberId: member.id }, defaults: { memberId: member.id, balance: 0 }, transaction: databaseTransaction });
      await account.increment('balance', { by: amount, transaction: databaseTransaction });
    }
    return created;
  });
  if (loanId) {
    try {
      await allocateMpesaRepayment({ ledgerTransactionId: transaction.id, receipt: transactionReference, confirmedAmount: amount, resultDescription: payment.description });
    } catch (error) {
      logger.error('KCB loan repayment allocation failed', { transactionId: transaction.id, loanId, error: error.message });
      return res.status(202).json({ transactionID: transactionReference, transactionId: transaction.id, statusCode: 0, statusMessage: 'Payment received and queued for reconciliation' });
    }
  }
  if (normalizedIdentifier === 'SC') {
    await settleShareCapitalPayment({ transactionId: transaction.id, receipt: transactionReference, amount, description: payment.description });
  }
  // Keep member screens and finance dashboards in sync with the posted ledger row.
  await publishBalanceUpdated(transaction, 'kcb_ipn');
  queuePaymentConfirmation(transaction.id).catch((error) => logger.error('KCB payment confirmation queue failed', { transactionId: transaction.id, error: error.message }));
  return res.json({ transactionID: transactionReference, transactionId: transaction.id, statusCode: 0, statusMessage: 'Payment processed' });
});

const isSavingsDepositPayment = (transaction) => {
  const category = String(transaction?.paymentCategory || '').toLowerCase();
  const type = String(transaction?.type || '').toUpperCase();
  return type === 'DEPOSIT' && ['savings', 'monthly_contribution', 'monthlycontribution', 'historical_savings'].includes(category);
};

const publishBalanceUpdated = async (transaction, reason) => {
  if (!transaction?.memberId) return;
  const member = await db.Member.findByPk(transaction.memberId, { attributes: ['id', 'userId'] }).catch(() => null);
  eventBus.publish('BALANCE_UPDATED', {
    userId: member?.userId || null,
    memberId: transaction.memberId,
    transactionId: transaction.id,
    paymentCategory: transaction.paymentCategory,
    amount: Number(transaction.amount || 0),
    status: transaction.status,
    reason,
  }, [
    member?.userId ? `user:${member.userId}` : null,
    `member:${transaction.memberId}`,
    'finance:dashboard',
    'admin:dashboard',
  ]);
};

const settleSavingsDepositPayment = async ({ transactionId, receipt, amount, description }) => (
  db.sequelize.transaction(async (databaseTransaction) => {
    const payment = await db.Transaction.findByPk(transactionId, {
      transaction: databaseTransaction,
      lock: databaseTransaction.LOCK.UPDATE,
    });
    if (!payment || !isSavingsDepositPayment(payment)) return payment;
    if (String(payment.status || '').toUpperCase() === 'SUCCESS') return payment;

    const paidAmount = Number(amount ?? payment.amount ?? 0);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0) throw new Error('Savings deposit amount is invalid');

    const [account] = await db.SavingsAccount.findOrCreate({
      where: { memberId: payment.memberId },
      defaults: { memberId: payment.memberId, balance: 0 },
      transaction: databaseTransaction,
    });
    await account.increment('balance', { by: paidAmount, transaction: databaseTransaction });
    await payment.update({
      status: 'SUCCESS',
      reference: receipt || payment.reference,
      amount: paidAmount,
      description: description || payment.description,
    }, { transaction: databaseTransaction });
    return payment;
  })
);

router.post('/stk', async (req, res, next) => {
  const configuredMpesaUrl = process.env.MPESA_URL?.trim();
  if (!configuredMpesaUrl) {
    return res.status(503).json({
      success: false,
      message: 'M-Pesa service is not configured',
    });
  }

  let mpesaUrl;
  try {
    const parsedUrl = new URL(configuredMpesaUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Unsupported protocol');
    mpesaUrl = parsedUrl.toString().replace(/\/+$/, '');
  } catch (error) {
    logger.error('Invalid MPESA_URL configuration', {
      error: error.message,
      requestId: req.id,
    });
    return res.status(503).json({
      success: false,
      message: 'M-Pesa service is misconfigured. Contact support.',
      errorCode: 'MPESA_INVALID_URL',
    });
  }

  const phone = String(req.body?.phone || '').trim();
  const amount = Number(req.body?.amount);
  if (!phone || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: 'A valid phone number and amount are required',
    });
  }

  try {
    const upstreamBody = {
      phone,
      amount: String(amount),
      applicationId: req.body?.applicationId || null,
      accountReference: req.body?.accountReference || null,
      paymentCategory: req.body?.paymentCategory || req.body?.category || null,
      category: req.body?.category || req.body?.paymentCategory || null,
      type: req.body?.type || null,
      internalReference: req.body?.internalReference || req.body?.internal_reference || null,
    };
    const upstream = await fetch(mpesaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(MPESA_PROXY_TIMEOUT_MS),
    });
    const text = await upstream.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { success: false, message: 'M-Pesa service returned an invalid response' };
    }
    if (!upstream.ok || !payload?.success) {
      const upstreamMessage = payload?.message || payload?.error || payload?.mpesa?.errorMessage || payload?.mpesa?.ResponseDescription || 'M-Pesa prompt could not be started.';
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({
        success: false,
        message: upstreamMessage,
        errorCode: 'MPESA_STK_FAILED',
        mpesa: payload?.mpesa || null,
      });
    }

    if (payload?.checkoutRequestId) {
      const checkoutRequestId = String(payload.checkoutRequestId);
      try {
        await getFirebaseDb().collection('registrations').doc(checkoutRequestId).set({
          checkout_request_id: checkoutRequestId,
          merchant_request_id: payload.merchantRequestId || null,
          phone,
          amount,
          transaction_id: payload.transaction?.id || null,
          internal_reference: payload.transaction?.internalReference || payload.accountReference || null,
          application_id: req.body?.applicationId || null,
          account_reference: payload.accountReference || req.body?.accountReference || null,
          status: 'pending',
          created_at: new Date(),
          updated_at: new Date(),
        }, { merge: true });
      } catch (error) {
        logger.error('Failed to persist pending STK status in Firebase', {
          error: error.message,
          checkoutRequestId,
          requestId: req.id,
        });
        return res.status(502).json({
          success: false,
          message: 'The payment prompt was sent, but its status could not be tracked. Please contact support before retrying.',
        });
      }
    }

    return res.status(202).json(payload);
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    logger.error('M-Pesa STK request failed', {
      error: error.message,
      timedOut,
      requestId: req.id,
    });
    return res.status(timedOut ? 504 : 502).json({
      success: false,
      message: timedOut
        ? 'M-Pesa took too long to start the phone prompt. Please wait one minute before retrying.'
        : 'Unable to connect to M-Pesa. Please try again.',
    });
  }
});

const getMetadataValue = (items = [], name) => {
  const item = items.find((entry) => entry.Name === name);
  return item?.Value;
};

router.post('/callback', async (req, res) => {
  try {
    const raw = req.body || {};
    logger.info('M-Pesa callback received', { callback: raw });

    const stk = raw?.Body?.stkCallback || raw?.stkCallback || raw?.result || raw;
    if (!stk) {
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stk;

    const success = Number(ResultCode) === 0;
    const items = CallbackMetadata?.Item || [];
    const receipt = getMetadataValue(items, 'MpesaReceiptNumber');
    const amount = getMetadataValue(items, 'Amount');
    const phone = getMetadataValue(items, 'PhoneNumber');
    const matchValue = CheckoutRequestID || MerchantRequestID;

    if (matchValue) {
      const registrationId = String(CheckoutRequestID || MerchantRequestID);
      try {
        await getFirebaseDb().collection('registrations').doc(registrationId).set({
          checkout_request_id: CheckoutRequestID || null,
          merchant_request_id: MerchantRequestID || null,
          status: success ? 'paid' : 'failed',
          mpesa_receipt: receipt || null,
          amount: amount == null ? null : Number(amount),
          phone: phone == null ? null : String(phone),
          result_code: Number(ResultCode),
          result_description: ResultDesc || null,
          updated_at: new Date(),
        }, { merge: true });
      } catch (firebaseError) {
        logger.error('M-Pesa callback Firebase mirror failed; continuing with primary ledger', { error: firebaseError.message, registrationId });
      }

      const where = {
        [db.Sequelize.Op.or]: [
          { reference: matchValue },
          { internalReference: matchValue },
          { checkoutRequestId: matchValue },
          { merchantRequestId: matchValue },
        ],
      };

      const transaction = await db.Transaction.findOne({ where });
      if (transaction) {
        if (success && transaction.type === 'LOAN_REPAYMENT' && transaction.loanId) {
          try {
            await allocateMpesaRepayment({ ledgerTransactionId: transaction.id, receipt, confirmedAmount: amount, resultDescription: ResultDesc });
          } catch (allocationError) {
            await transaction.update({
              status: 'PENDING',
              reference: receipt || transaction.reference,
              amount: amount ? Number(amount) : transaction.amount,
              description: `ALLOCATION_FAILED: ${allocationError.message}`,
            });
            logger.error('M-Pesa loan repayment allocation failed and was persisted for reconciliation', {
              transactionId: transaction.id,
              loanId: transaction.loanId,
              receipt,
              error: allocationError.message,
            });
          }
        } else if (success && isShareCapitalPayment(transaction)) {
          await settleShareCapitalPayment({
            transactionId: transaction.id,
            receipt,
            amount: amount == null ? transaction.amount : Number(amount),
            description: ResultDesc,
          });
          await publishBalanceUpdated(transaction, 'share_capital_payment');
        } else if (success && isSavingsDepositPayment(transaction)) {
          await settleSavingsDepositPayment({
            transactionId: transaction.id,
            receipt,
            amount: amount == null ? transaction.amount : Number(amount),
            description: ResultDesc,
          });
          await publishBalanceUpdated(transaction, 'savings_deposit_payment');
        } else {
          await transaction.update({ status: success ? 'SUCCESS' : 'FAILED', reference: receipt || transaction.reference, amount: amount ? Number(amount) : transaction.amount, description: ResultDesc || transaction.description });
          if (success) await publishBalanceUpdated(transaction, 'mpesa_callback');
        }
        if (success) {
          // Deliberately do not await external delivery; reconciliation and the
          // webhook acknowledgement must remain fast and reliable.
          queuePaymentConfirmation(transaction.id).catch((error) => logger.error('M-Pesa payment confirmation queue failed', { transactionId: transaction.id, error: error.message }));
        }
      } else {
        logger.warn('M-Pesa callback transaction not found', {
          MerchantRequestID,
          CheckoutRequestID,
          ResultCode,
        });
      }
    }

    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    logger.error('M-Pesa callback handling failed', {
      error: error.message,
      stack: error.stack,
    });

    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

module.exports = router;
