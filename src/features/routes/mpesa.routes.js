const express = require('express');
const db = require('../../models');
const logger = require('../../shared/utils/logger');

const router = express.Router();

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
    const matchValue = CheckoutRequestID || MerchantRequestID;

    if (matchValue) {
      const where = {
        [db.Sequelize.Op.or]: [
          { reference: matchValue },
          { internalReference: matchValue },
        ],
      };

      const transaction = await db.Transaction.findOne({ where });
      if (transaction) {
        await transaction.update({
          status: success ? 'SUCCESS' : 'FAILED',
          reference: receipt || transaction.reference,
          amount: amount ? Number(amount) : transaction.amount,
          description: ResultDesc || transaction.description,
        });
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
