const CENTS = 100;
const DAYS_IN_MONTH = 30;
const DEFAULT_AMORTIZATION = 'REDUCING_BALANCE';

const toCents = (value) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * CENTS);
};

const fromCents = (cents) => Math.round(Number(cents || 0)) / CENTS;

const normalizeAmortization = (value) => {
  const normalized = String(value || DEFAULT_AMORTIZATION).toUpperCase();
  return ['SIMPLE_INTEREST', 'REDUCING_BALANCE'].includes(normalized)
    ? normalized
    : DEFAULT_AMORTIZATION;
};

const daysBetween = (start, end) => {
  const startDate = start ? new Date(start) : new Date(end);
  const endDate = end ? new Date(end) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(0, Math.floor((endDate.getTime() - startDate.getTime()) / 86400000));
};

const calculateAccruedInterestCents = ({
  originalPrincipalCents,
  currentPrincipalCents,
  accruedInterestCents = 0,
  annualRatePercent = 0,
  accruedDays = 0,
  amortization = DEFAULT_AMORTIZATION,
}) => {
  const rate = Number(annualRatePercent || 0) / 100;
  const basePrincipal = normalizeAmortization(amortization) === 'SIMPLE_INTEREST'
    ? originalPrincipalCents
    : currentPrincipalCents;
  const interest = Math.round(basePrincipal * (rate / DAYS_IN_MONTH) * accruedDays);
  return Math.max(0, accruedInterestCents + interest);
};

const calculateLoanPaymentAllocation = ({ loan, amount, paymentDate = new Date() }) => {
  const paymentCents = toCents(amount);
  const originalPrincipalCents = toCents(loan.amount);
  const currentPrincipalCents = toCents(loan.principalBalance ?? loan.amount);
  const storedInterestCents = toCents(loan.accruedInterest || 0);
  const accruedDays = daysBetween(loan.lastInterestAccrualAt || loan.decidedAt || loan.createdAt, paymentDate);
  const amortization = normalizeAmortization(loan.amortizationMethod || loan.amortization || loan.metadata?.amortizationMethod);
  const accruedInterestCents = calculateAccruedInterestCents({
    originalPrincipalCents,
    currentPrincipalCents,
    accruedInterestCents: storedInterestCents,
    annualRatePercent: loan.interestRate,
    accruedDays,
    amortization,
  });
  const outstandingCents = currentPrincipalCents + accruedInterestCents;

  if (paymentCents <= 0) {
    const error = new Error('Payment amount must be greater than zero');
    error.statusCode = 400;
    throw error;
  }
  if (paymentCents > outstandingCents) {
    const error = new Error(`Payment exceeds outstanding balance of KES ${fromCents(outstandingCents).toFixed(2)}`);
    error.statusCode = 400;
    throw error;
  }

  const interestPaidCents = Math.min(paymentCents, accruedInterestCents);
  const principalPaidCents = Math.min(paymentCents - interestPaidCents, currentPrincipalCents);
  const remainingInterestCents = accruedInterestCents - interestPaidCents;
  const remainingPrincipalCents = currentPrincipalCents - principalPaidCents;
  const newOutstandingCents = remainingPrincipalCents + remainingInterestCents;

  return {
    amortization,
    accruedDays,
    paymentCents,
    outstandingBeforeCents: outstandingCents,
    principalPaidCents,
    interestPaidCents,
    remainingPrincipalCents,
    remainingInterestCents,
    newOutstandingCents,
    paymentAmount: fromCents(paymentCents),
    outstandingBefore: fromCents(outstandingCents),
    principalPaid: fromCents(principalPaidCents),
    interestPaid: fromCents(interestPaidCents),
    interestEarned: fromCents(interestPaidCents),
    remainingPrincipal: fromCents(remainingPrincipalCents),
    remainingInterest: fromCents(remainingInterestCents),
    newOutstandingBalance: fromCents(newOutstandingCents),
    paidOff: newOutstandingCents === 0,
  };
};

module.exports = {
  DEFAULT_AMORTIZATION,
  toCents,
  fromCents,
  normalizeAmortization,
  calculateAccruedInterestCents,
  calculateLoanPaymentAllocation,
};
