const express = require('express');
const db = require('../../models');
const logger = require('../../shared/utils/logger');
const { getFirebaseDb } = require('../../shared/config/firebase');
const { allocateMpesaRepayment } = require('../loans/services/loanRepaymentService');

const router = express.Router();
const MPESA_PROXY_TIMEOUT_MS = Number(process.env.MPESA_TIMEOUT_MS || 115000);

router.post('/stk', async (req, res, next) => {
  const mpesaUrl = process.env.MPESA_URL?.trim().replace(/\/+$/, '');
  if (!mpesaUrl) {
    return res.status(503).json({
      success: false,
      message: 'M-Pesa service is not configured',
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

    return res.status(200).json(payload);
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
        } else {
          await transaction.update({ status: success ? 'SUCCESS' : 'FAILED', reference: receipt || transaction.reference, amount: amount ? Number(amount) : transaction.amount, description: ResultDesc || transaction.description });
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
