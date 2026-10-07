const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAccountReference, parseAccountReference } = require('../src/features/routes/mpesaReference');

test('builds the canonical KCB account reference without truncating the member suffix', () => {
  assert.equal(buildAccountReference('29903-00033', 'MS'), '7929884#MS00033');
  assert.equal(buildAccountReference('7929884-MS00033', 'MS'), '7929884#MS00033');
  assert.equal(buildAccountReference('MS00033', '#SC'), '7929884#SC00033');
});

test('parses canonical and KCB separator-stripped callback references', () => {
  for (const designator of ['MS', 'SC', 'LM', 'LE', 'LW', 'LD']) {
    assert.deepEqual(parseAccountReference(`7929884#${designator}00033`), { designator, memberSuffix: '00033' });
    assert.deepEqual(parseAccountReference(`7929884${designator}00033`), { designator, memberSuffix: '00033' });
    assert.deepEqual(parseAccountReference(`7929884-${designator}00033`), { designator, memberSuffix: '00033' });
  }
});
