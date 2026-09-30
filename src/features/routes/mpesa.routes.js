const express = require('express');
const db = require('../../models');
const logger = require('../../shared/utils/logger');
const { getFirebaseDb } = require('../../shared/config/firebase');
const { allocateMpesaRepayment } = require('../loans/services/loanRepaymentService');
const { isShareCapitalPayment, settleShareCapitalPayment } = require('../shares/services/shareCapitalPaymentService');
const eventBus = require('../../services/realtime/eventBus');

const router = express.Router();
const MPESA_PROXY_TIMEOUT_MS = Number(process.env.MPESA_TIMEOUT_MS || 115000);

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
