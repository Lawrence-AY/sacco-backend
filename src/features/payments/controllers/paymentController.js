const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { ValidationError } = require('../../../shared/utils/errors');
const { postLoanPayment } = require('../../loans/services/loanRepaymentService');

const createPayment = asyncHandler(async (req, res) => {
  const { loanId, amount, reference, method, evidence } = req.body || {};
  if (!loanId) throw new ValidationError('loanId is required');
  if (!amount) throw new ValidationError('amount is required');
  const normalizedMethod = String(method || 'MANUAL').toUpperCase();

  const result = await postLoanPayment({
    loanId,
    amount,
    reference,
    evidence,
    method: normalizedMethod,
    postedByUserId: req.user.id,
    actorUser: req.user,
    source: 'API',
  });

  return ResponseHandler.created(res, result.eventPayload, 'Payment processed successfully');
});

module.exports = {
  createPayment,
};
