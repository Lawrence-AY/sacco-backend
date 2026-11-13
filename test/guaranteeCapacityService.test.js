const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateCapacity,
  calculateGuaranteeProgress,
  outstandingObligationsForLoans,
  pledgeHoldForLoan,
  selfGuaranteeHoldForLoan,
} = require('../src/features/loans/services/guaranteeCapacityService');

test('only actual third-party pledges and remaining self-guarantees reduce savings capacity', () => {
  const capacity = calculateCapacity({ totalSavings: 100000, pledgeHolds: 20000, selfGuaranteeHolds: 10000 });
  assert.equal(capacity.committedCapacity, 30000);
  assert.equal(capacity.freeSavings, 70000);
});

test('multiple active loan balances are reported separately from savings capacity', () => {
  const loans = [
    { status: 'ACTIVE', principalBalance: 30000, accruedInterest: 1000 },
    { status: 'DISBURSED', principalBalance: 20000, accruedInterest: 0 },
    { status: 'COMPLETED', principalBalance: 0, accruedInterest: 0, amount: 50000 },
  ];
  assert.equal(outstandingObligationsForLoans(loans), 51000);
  assert.equal(calculateCapacity({ totalSavings: 90000, pledgeHolds: 15000, selfGuaranteeHolds: 0 }).freeSavings, 75000);
});

test('partial repayment releases only the repaid portion of a self-guarantee hold', () => {
  const hold = selfGuaranteeHoldForLoan({
    selfGuaranteed: true,
    selfGuaranteedAmount: 40000,
    status: 'ACTIVE',
    principalBalance: 12000,
    accruedInterest: 3000,
  });
  assert.equal(hold, 15000);
});

test('a fully repaid loan releases its self-guarantee hold and is not an open obligation', () => {
  const loan = { selfGuaranteed: true, selfGuaranteedAmount: 40000, status: 'COMPLETED', principalBalance: 0, amount: 40000 };
  assert.equal(selfGuaranteeHoldForLoan(loan), 0);
  assert.equal(outstandingObligationsForLoans([loan]), 0);
});

test('a denied disbursement does not reserve savings for a self-guarantee', () => {
  assert.equal(selfGuaranteeHoldForLoan({
    selfGuaranteed: true,
    selfGuaranteedAmount: 25000,
    status: 'APPROVED',
    disbursementStatus: 'DENIED',
    amount: 25000,
  }), 0);
});

test('partial guarantees count accepted amounts and show the remaining loan requirement', () => {
  const progress = calculateGuaranteeProgress({
    loanAmount: 100000,
    selfGuaranteedAmount: 10000,
    pledges: [
      { status: 'ACCEPTED', amount: 25000 },
      { status: 'PENDING', amount: 65000 },
    ],
  });
  assert.equal(progress.totalGuaranteed, 35000);
  assert.equal(progress.totalRequested, 100000);
  assert.equal(progress.remainingToGuarantee, 65000);
  assert.equal(progress.fullyGuaranteed, false);
});

test('multiple accepted guarantors satisfy the full guarantee without counting rejected or released pledges', () => {
  const progress = calculateGuaranteeProgress({
    loanAmount: 90000,
    selfGuaranteedAmount: 10000,
    pledges: [
      { status: 'ACCEPTED', amount: 30000 },
      { status: 'ACCEPTED', amount: 50000 },
      { status: 'REJECTED', amount: 10000 },
      { status: 'RELEASED', amount: 5000 },
    ],
  });
  assert.equal(progress.totalGuaranteed, 90000);
  assert.equal(progress.fullyGuaranteed, true);
  assert.equal(progress.remainingToGuarantee, 0);
});

test('accepted guarantees stop holding savings after the secured loan is closed or disbursement is denied', () => {
  const pledge = { amount: 25000, status: 'ACCEPTED' };
  assert.equal(pledgeHoldForLoan(pledge, { status: 'ACTIVE', disbursementStatus: 'COMPLETE' }), 25000);
  assert.equal(pledgeHoldForLoan(pledge, { status: 'COMPLETED', disbursementStatus: 'COMPLETE' }), 0);
  assert.equal(pledgeHoldForLoan(pledge, { status: 'ACTIVE', disbursementStatus: 'DENIED' }), 0);
});
