const db = require('../../../models');
const userService = require('../../users/services/userService');
const loanService = require('../../loans/services/loanService');
const shareService = require('../../shares/services/shareService');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const { UserDTO, LoanDTO, TransactionDTO } = require('../../../shared/utils/dtos');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;
const DEFAULT_KCB_MPESA_BASE_URL = 'https://kcb-mpesa.simrion.workers.dev';
const LOCAL_KCB_MPESA_BASE_URL = 'https://kcb-mpesa.simrion.workers.dev';
const DEFAULT_KCB_PAYBILL_NUMBER = '522522';

const getKcbMpesaBaseUrl = () => {
  if (process.env.KCB_MPESA_BASE_URL) {
    return process.env.KCB_MPESA_BASE_URL;
  }
  return process.env.NODE_ENV === 'production'
    ? DEFAULT_KCB_MPESA_BASE_URL
    : LOCAL_KCB_MPESA_BASE_URL;
};

const findMemberByUserId = async (userId) => {
  return db.Member.findOne({ where: { userId } });
};

const ensureMemberByUser = async (user) => {
  let member = await findMemberByUserId(user.id);
  if (!member) {
    member = await db.Member.create({
      userId: user.id,
      memberNumber: `M-${Date.now()}`,
      nationalId: user.nationalId || null,
      type: 'NON_EMPLOYEE',
      isVerified: true,
    });
  }

  const savings = await db.SavingsAccount.findOne({ where: { memberId: member.id } });
  if (!savings) {
    await db.SavingsAccount.create({ memberId: member.id });
  }

  const shares = await db.ShareAccount.findOne({ where: { memberId: member.id } });
  if (!shares) {
    await db.ShareAccount.create({ memberId: member.id });
  }

  return member;
};

const buildTransactionDescription = (transaction) => {
  const pieces = [transaction.type];
  if (transaction.method) {
    pieces.push(`via ${transaction.method}`);
  }
  if (transaction.reference) {
    pieces.push(`ref: ${transaction.reference}`);
  }
  return pieces.join(' | ');
};

const formatShareAccount = (share) => {
  const totalInvested = Number((share.shares || 0) * (share.shareValue || 0));
  return {
    id: share.id,
    memberId: share.memberId,
    shares: share.shares,
    shareValue: share.shareValue,
    totalInvested,
    purchaseDate: share.createdAt,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
};

const getProfile = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.private(user), 'Profile retrieved successfully');
});

const updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['firstName', 'lastName', 'name', 'email', 'phone', 'nationalId', 'kraPin', 'occupation', 'address', 'consentGiven'];
  const safeBody = allowed.reduce((acc, field) => {
    if (req.body[field] !== undefined) acc[field] = req.body[field];
    return acc;
  }, {});
  const updated = await userService.updateUser(req.user.id, safeBody);
  if (!updated) {
    throw new NotFoundError('User not found');
  }
  return ResponseHandler.success(res, UserDTO.private(updated), 'Profile updated successfully', 200);
});

const getLoans = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No loans found', 200);
  }

  const loans = await db.Loan.findAll({
    where: { memberId: member.id },
    include: [db.Guarantor],
    order: [['createdAt', 'DESC']],
  });

  const formatted = loans.map((loan) => ({
    id: loan.id,
    memberId: loan.memberId,
    type: loan.type,
    principal: loan.amount,
    balance: loan.amount,
    status: loan.status,
    approvedAt: loan.updatedAt,
    createdAt: loan.createdAt,
    guarantors: loan.Guarantors || [],
  }));

  return ResponseHandler.success(res, formatted, 'Member loans retrieved successfully', 200);
});

const applyForLoan = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  if (!req.body.amount || !req.body.type) {
    throw new ValidationError('Loan amount and type are required');
  }

  const loan = await loanService.createLoan({
    ...req.body,
    memberId: member.id,
    status: 'PENDING',
  });

  return ResponseHandler.created(res, LoanDTO.basic(loan, req.user), 'Loan application submitted successfully');
});

const cancelLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }

  if (loan.memberId !== member.id) {
    throw new ForbiddenError('You do not own this loan');
  }

  if (loan.status !== 'PENDING' && loan.status !== 'APPROVED') {
    throw new ValidationError('Loan cannot be cancelled at this stage');
  }

  const updated = await loanService.updateLoanStatus(loan.id, 'REJECTED');
  return ResponseHandler.success(res, updated, 'Loan cancelled successfully', 200);
});

const getShares = asyncHandler(async (req, res) => {
  const shares = await shareService.getShareAccountsForUser(req.user);
  const formatted = shares.map(formatShareAccount);
  return ResponseHandler.success(res, formatted, 'Share accounts retrieved successfully', 200);
});

const buyShares = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const { shares, amount } = req.body;
  if (shares === undefined && amount === undefined) {
    throw new ValidationError('Shares or amount is required');
  }

  const shareAccount = await db.ShareAccount.findOne({ where: { memberId: member.id } });
  if (!shareAccount) {
    throw new NotFoundError('Share account not found');
  }

  const shareCount = shares !== undefined ? Number(shares) : Number(amount) / Number(shareAccount.shareValue || 1);
  if (isNaN(shareCount) || shareCount <= 0) {
    throw new ValidationError('Invalid share quantity or amount');
  }

  await shareAccount.update({ shares: shareAccount.shares + shareCount });
  return ResponseHandler.success(res, formatShareAccount(shareAccount), 'Shares purchased successfully', 200);
});

const getTransactions = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No transactions found', 200);
  }

  const where = { memberId: member.id };
  if (req.query.type) where.type = req.query.type;

  const transactions = await db.Transaction.findAll({ where, order: [['createdAt', 'DESC']] });
  const formatted = transactions.map((transaction) => ({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
  }));

  return ResponseHandler.success(res, formatted, 'Transactions retrieved successfully', 200);
});

const getGuarantees = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    return ResponseHandler.success(res, [], 'No guarantees found', 200);
  }

  const guarantees = await db.Guarantor.findAll({
    where: { memberId: member.id },
    include: [
      { model: db.Loan, attributes: ['id', 'type', 'amount', 'status'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  const formatted = guarantees.map((guarantee) => ({
    id: guarantee.id,
    loanId: guarantee.loanId,
    amount: guarantee.amount,
    createdAt: guarantee.createdAt,
    loan: guarantee.Loan ? {
      id: guarantee.Loan.id,
      type: guarantee.Loan.type,
      amount: guarantee.Loan.amount,
      status: guarantee.Loan.status,
    } : null,
  }));

  return ResponseHandler.success(res, formatted, 'Guarantees retrieved successfully', 200);
});

const repayLoan = asyncHandler(async (req, res) => {
  const member = await findMemberByUserId(req.user.id);
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Repayment amount is required');
  }

  const loan = await loanService.getLoanById(req.params.loanId);
  if (!loan) {
    throw new NotFoundError('Loan not found');
  }
  if (loan.memberId !== member.id) {
    throw new ForbiddenError('You do not own this loan');
  }
  if (!['ACTIVE', 'APPROVED'].includes(loan.status)) {
    throw new ValidationError('Loan is not eligible for repayment');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    loanId: loan.id,
    type: 'LOAN_REPAYMENT',
    amount,
    method: req.body.method || 'MANUAL',
    status: 'SUCCESS',
    reference: req.body.reference || `REPAY-${Date.now()}`
  });

  return ResponseHandler.created(res, TransactionDTO.basic({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
  }, 'Loan repayment recorded successfully');
});

const depositSavings = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Deposit amount is required');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    type: 'DEPOSIT',
    amount,
    method: req.body.method || 'MANUAL',
    status: 'SUCCESS',
    reference: req.body.reference || `DEP-${Date.now()}`
  });

  return ResponseHandler.created(res, TransactionDTO.basic({
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    description: buildTransactionDescription(transaction),
    createdAt: transaction.createdAt,
    status: transaction.status,
    method: transaction.method,
    reference: transaction.reference,
    mpesaReference: transaction.method === 'MPESA' ? transaction.reference : null,
  }, 'Savings deposit recorded successfully');
});

const getKcbEndpointForContribution = (type) => {
  const normalized = String(type || 'monthly').toLowerCase();
  if (normalized.includes('share')) return '/sharecapital';
  if (normalized.includes('saving')) return '/savings';
  return '/monthlycontributions';
};

const initiateContribution = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);

  const amount = Number(req.body?.amount || 0);
  if (!amount || amount <= 0) {
    throw new ValidationError('Contribution amount is required');
  }

  const phone = req.body?.phone || req.user.phone;
  const paymentMode = String(req.body?.paymentMode || 'STK').toUpperCase();
  const contributionType = req.body?.contributionType || 'monthly';
  const reference = `CONTRIB-${Date.now()}`;
  const memberNumber = member.memberNumber || reference;

  if (paymentMode === 'STK' && !phone) {
    throw new ValidationError('Phone number is required for STK push');
  }

  const transaction = await db.Transaction.create({
    memberId: member.id,
    type: 'DEPOSIT',
    amount,
    method: 'MPESA',
    status: 'PENDING',
    reference,
  });

  if (paymentMode === 'PAYBILL') {
    return ResponseHandler.created(res, {
      id: transaction.id,
      type: transaction.type,
      amount: transaction.amount,
      status: transaction.status,
      method: transaction.method,
      reference: transaction.reference,
      paybill: {
        businessNumber: process.env.KCB_PAYBILL_NUMBER || process.env.MPESA_PAYBILL_NUMBER || DEFAULT_KCB_PAYBILL_NUMBER,
        accountNumber: memberNumber,
        amount,
        steps: [
          'Open M-PESA on your phone or SIM toolkit.',
          'Select Lipa na M-PESA.',
          'Select Pay Bill.',
          'Enter the business number shown here.',
          'Enter the account number shown here.',
          'Enter the amount and confirm with your PIN.',
          'Keep the MPESA confirmation message for your records.',
        ],
      },
    }, 'Contribution recorded. Complete payment using Paybill.');
  }

  const workerBaseUrl = getKcbMpesaBaseUrl();
  if (!workerBaseUrl) {
    await transaction.update({ status: 'FAILED' });
    throw new ValidationError('STK push is not configured. Set KCB_MPESA_BASE_URL on the backend or use Paybill.');
  }

  const endpoint = getKcbEndpointForContribution(contributionType);
  const workerUrl = `${workerBaseUrl.replace(/\/$/, '')}${endpoint}`;
  console.info('[MEMBER] Sending KCB-MPESA STK request', {
    workerUrl,
    phone,
    amount: Math.round(amount),
    contributionType,
  });

  const workerRes = await fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      amount: Math.round(amount),
      invoiceNumber: memberNumber,
      member_number: memberNumber,
      internal_reference: reference,
      name: req.user.name || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
      reference,
    }),
  });

  const workerText = await workerRes.text();
  let workerPayload = null;
  try {
    workerPayload = workerText ? JSON.parse(workerText) : null;
  } catch {
    workerPayload = { raw: workerText };
  }

  if (!workerRes.ok) {
    await transaction.update({ status: 'FAILED' });
    const workerMessage = workerPayload?.error || workerPayload?.message || workerPayload?.raw || 'KCB-MPESA STK push failed';
    throw new ValidationError(`KCB-MPESA STK push failed (${workerRes.status}): ${workerMessage}`);
  }

  const mpesaRequestReference = workerPayload?.merchantRequestId || workerPayload?.checkoutRequestId || null;
  if (!mpesaRequestReference) {
    await transaction.update({ status: 'FAILED' });
    throw new ValidationError(workerPayload?.message || 'KCB-MPESA accepted the request but did not return a request reference. STK push was not confirmed.');
  }

  await transaction.update({
    reference: mpesaRequestReference,
  });

  return ResponseHandler.created(res, {
    id: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    status: transaction.status,
    method: transaction.method,
    reference: mpesaRequestReference,
    internalReference: reference,
    mpesaReference: mpesaRequestReference,
    kcbMpesa: workerPayload,
  }, workerPayload?.message || workerPayload?.customerMessage || 'STK push sent. Check your phone and enter your M-PESA PIN.');
});

const checkContributionStatus = asyncHandler(async (req, res) => {
  const member = await ensureMemberByUser(req.user);
  const transaction = await db.Transaction.findOne({
    where: {
      id: req.params.transactionId,
      memberId: member.id,
    },
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  if (!supabase || !transaction.reference) {
    return ResponseHandler.success(res, {
      id: transaction.id,
      status: transaction.status,
      reference: transaction.reference,
      mpesaReference: transaction.reference,
    }, 'Contribution status retrieved');
  }

  const { data, error } = await supabase
    .from('registrations')
    .select('status, mpesa_receipt, transaction_reference, merchant_request_id, checkout_request_id')
    .or(`merchant_request_id.eq.${transaction.reference},checkout_request_id.eq.${transaction.reference},request_id.eq.${transaction.reference}`)
    .maybeSingle();

  if (error) {
    console.error('[MEMBER] Failed to fetch contribution status', { message: error.message });
  }

  const isPaid = data?.status === 'paid';
  const isFailed = data?.status === 'failed';
  const receipt = data?.mpesa_receipt || data?.transaction_reference || null;

  if (isPaid && transaction.status !== 'SUCCESS') {
    await transaction.update({
      status: 'SUCCESS',
      reference: receipt || transaction.reference,
    });
  } else if (isFailed && transaction.status !== 'FAILED') {
    await transaction.update({ status: 'FAILED' });
  }

  return ResponseHandler.success(res, {
    id: transaction.id,
    status: isPaid ? 'SUCCESS' : isFailed ? 'FAILED' : transaction.status,
    reference: receipt || transaction.reference,
    mpesaReference: receipt || transaction.reference,
    checkoutRequestId: data?.checkout_request_id || null,
    merchantRequestId: data?.merchant_request_id || null,
  }, 'Contribution status retrieved');
});

const emailReport = asyncHandler(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const reportType = req.body?.reportType || 'portfolio';
  const member = await findMemberByUserId(req.user.id);
  const transactions = member
    ? await db.Transaction.findAll({ where: { memberId: member.id }, order: [['createdAt', 'DESC']], limit: 20 })
    : [];
  const loans = member
    ? await db.Loan.findAll({ where: { memberId: member.id }, order: [['createdAt', 'DESC']] })
    : [];
  const shares = await shareService.getShareAccountsForUser(req.user);

  const shareCapital = shares.reduce((sum, share) => sum + Number((share.shares || 0) * (share.shareValue || 0)), 0);
  const outstandingLoans = loans.reduce((sum, loan) => sum + Number(loan.amount || 0), 0);
  const transactionTotal = transactions.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"Ayedos SACCO" <${process.env.SMTP_USER}>`,
    to: user.email,
    subject: `AYEDOS SACCO ${reportType} report`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a;">
        <h2>AYEDOS SACCO ${reportType} report</h2>
        <p>Hello ${user.name || 'Member'},</p>
        <p>Your requested report summary is below.</p>
        <ul>
          <li><strong>Share capital:</strong> KSh ${Math.round(shareCapital).toLocaleString()}</li>
          <li><strong>Outstanding loans:</strong> KSh ${Math.round(outstandingLoans).toLocaleString()}</li>
          <li><strong>Recent transaction total:</strong> KSh ${Math.round(transactionTotal).toLocaleString()}</li>
          <li><strong>Loans:</strong> ${loans.length}</li>
          <li><strong>Transactions reviewed:</strong> ${transactions.length}</li>
        </ul>
        <p>Generated at ${new Date().toISOString()}.</p>
      </div>
    `
  });

  return ResponseHandler.success(res, null, 'Report sent to your email', 200);
});

module.exports = {
  getProfile,
  updateProfile,
  getLoans,
  applyForLoan,
  cancelLoan,
  repayLoan,
  depositSavings,
  initiateContribution,
  checkContributionStatus,
  getShares,
  buyShares,
  getTransactions,
  getGuarantees,
  emailReport,
};
