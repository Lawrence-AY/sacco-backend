const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyNominees } = require('../src/features/member/services/nomineeVerificationService');

const nominee = { fullName: 'Jane Mary Doe', nationalId: '12345678', allocationPercentage: 60 };

test('verifies complete identities and records server-generated status', async () => {
  const result = await verifyNominees([nominee], [], { enabled: true, verify: async (payload) => {
    assert.deepEqual(payload, { idNumber: '12345678', documentType: 'national', firstName: 'Jane', surname: 'Doe' });
    return { success: true };
  } });
  assert.equal(result[0].verificationStatus, 'VERIFIED');
  assert.ok(result[0].verifiedAt);
});

test('rejects mismatches and propagates provider outages', async () => {
  await assert.rejects(verifyNominees([nominee], [], { enabled: true, verify: async () => ({ success: false }) }), /could not verify nominee 1/);
  await assert.rejects(verifyNominees([nominee], [], { enabled: true, verify: async () => { throw new Error('IPRS unavailable'); } }), /IPRS unavailable/);
});

test('disabled verification and partial drafts are never marked verified', async () => {
  assert.equal((await verifyNominees([nominee], [], { enabled: false }))[0].verificationStatus, 'UNAVAILABLE');
  assert.equal((await verifyNominees([{ fullName: 'Jane' }], [], { enabled: true }))[0].verificationStatus, 'DRAFT');
});

test('rejects excess allocation and duplicate IDs before provider calls', async () => {
  await assert.rejects(verifyNominees([nominee, { ...nominee, nationalId: '87654321' }]), /exceed 100/);
  await assert.rejects(verifyNominees([nominee, { ...nominee, allocationPercentage: 20 }]), /different National ID/);
});

test('locks verified identity while allowing contact and allocation changes', async () => {
  const previous = [{ ...nominee, verificationStatus: 'VERIFIED', verifiedAt: '2026-09-09' }];
  const verify = async () => { throw new Error('verification requested'); };
  assert.equal((await verifyNominees([nominee], previous, { enabled: true, verify }))[0].verifiedAt, '2026-09-09');
  const updated = await verifyNominees([{ ...nominee, phone: '0712345678', relationship: 'Sibling', allocationPercentage: 50 }], previous, { enabled: true, verify });
  assert.equal(updated[0].phone, '0712345678');
  assert.equal(updated[0].relationship, 'Sibling');
  assert.equal(updated[0].allocationPercentage, 50);
  assert.equal(updated[0].verificationStatus, 'VERIFIED');
  for (const enabled of [true, false]) {
    for (const draft of [[{ ...nominee, nationalId: '87654321' }], [{ ...nominee, fullName: 'Jane Smith' }], []]) {
      await assert.rejects(verifyNominees(draft, previous, { enabled, verify }), /verified nominee cannot/);
    }
  }
});

test('verified identity remains locked when rows are reordered', async () => {
  const verified = { ...nominee, verificationStatus: 'VERIFIED', verifiedAt: '2026-09-09' };
  const result = await verifyNominees([{ fullName: 'Draft' }, nominee], [verified], { enabled: false });
  assert.equal(result[1].verificationStatus, 'VERIFIED');
});
