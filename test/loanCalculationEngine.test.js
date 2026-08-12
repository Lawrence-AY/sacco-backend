const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLoanPaymentAllocation } = require('../src/features/loans/services/loanCalculationEngine');

const baseLoan = {
  amount: 1000,
  principalBalance: 1000,
  accruedInterest: 0,
  interestRate: 3,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  decidedAt: new Date('2026-01-01T00:00:00.000Z'),
  lastInterestAccrualAt: new Date('2026-01-01T00:00:00.000Z'),
};

test('partial payment below accrued interest reduces interest first', () => {
  const result = calculateLoanPaymentAllocation({
    loan: { ...baseLoan, accruedInterest: 50 },
    amount: 25,
    paymentDate: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(result.interestPaid, 25);
  assert.equal(result.principalPaid, 0);
  assert.equal(result.remainingPrincipal, 1000);
  assert.equal(result.remainingInterest, 25);
  assert.equal(result.newOutstandingBalance, 1025);
});

test('payment above interest splits interest and principal deterministically', () => {
  const result = calculateLoanPaymentAllocation({
    loan: { ...baseLoan, accruedInterest: 50 },
    amount: 250,
    paymentDate: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(result.interestPaid, 50);
  assert.equal(result.principalPaid, 200);
  assert.equal(result.remainingPrincipal, 800);
  assert.equal(result.newOutstandingBalance, 800);
});

test('exact payoff produces zero balance and paidOff=true', () => {
  const result = calculateLoanPaymentAllocation({
    loan: { ...baseLoan, principalBalance: 100, accruedInterest: 5 },
    amount: 105,
    paymentDate: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(result.remainingPrincipal, 0);
  assert.equal(result.remainingInterest, 0);
  assert.equal(result.newOutstandingBalance, 0);
  assert.equal(result.paidOff, true);
});

test('overpayment is rejected', () => {
  assert.throws(() => calculateLoanPaymentAllocation({
    loan: { ...baseLoan, principalBalance: 100, accruedInterest: 5 },
    amount: 105.01,
    paymentDate: new Date('2026-01-01T00:00:00.000Z'),
  }), /exceeds outstanding balance/);
});

test('reducing balance interest accrues from current principal using cents', () => {
  const result = calculateLoanPaymentAllocation({
    loan: {
      ...baseLoan,
      amount: 1000.13,
      principalBalance: 500.13,
      interestRate: 3,
    },
    amount: 1,
    paymentDate: new Date('2026-01-31T00:00:00.000Z'),
  });

  assert.equal(result.interestPaid, 1);
  assert.equal(result.principalPaid, 0);
  assert.equal(result.remainingPrincipal, 500.13);
});
