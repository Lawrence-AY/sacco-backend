const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIdentityProfile, assertIdentityProfileUnchanged } = require('../src/shared/utils/identityProfile');

test('normalizes IPRS dates and gender', () => {
  assert.deepEqual(normalizeIdentityProfile({ dateOfBirth: '9/2/1990', gender: 'F' }), { dateOfBirth: '1990-02-09', gender: 'Female' });
  assert.deepEqual(normalizeIdentityProfile({ dateOfBirth: '1990-02-09T00:00:00Z', gender: 'MALE' }), { dateOfBirth: '1990-02-09', gender: 'Male' });
});

test('missing or invalid birth dates are not saved', () => {
  for (const dateOfBirth of ['', 'unknown', '31/02/1990']) assert.deepEqual(normalizeIdentityProfile({ dateOfBirth }), {});
});

test('captured demographics cannot be changed or cleared', () => {
  const current = { dateOfBirth: '1990-02-09', gender: 'Female' };
  for (const changes of [{ dateOfBirth: '' }, { dateOfBirth: '1991-02-09' }, { gender: 'Male' }, { gender: null }]) {
    assert.throws(() => assertIdentityProfileUnchanged(current, changes), /cannot be edited/);
  }
  assert.doesNotThrow(() => assertIdentityProfileUnchanged(current, current));
  assert.doesNotThrow(() => assertIdentityProfileUnchanged(current, { phone: '0712345678' }));
  assert.doesNotThrow(() => assertIdentityProfileUnchanged({}, current));
});
