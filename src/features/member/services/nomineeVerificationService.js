const iprs = require('../../../services/iprs');
const config = require('../../../shared/config/iprs');
const { ValidationError } = require('../../../shared/utils/errors');

async function verifyNominees(nominees, previous = [], { enabled = config.enabled, verify = iprs.verifyIdentity } = {}) {
  for (const verified of previous.filter((item) => item.verificationStatus === 'VERIFIED')) {
    const unchanged = nominees.some((item) => (
      (item.nationalId || '').trim() === verified.nationalId
      && (item.fullName || '').trim() === verified.fullName
    ));
    if (!unchanged) throw new ValidationError('A verified nominee cannot be removed or have their full name or National ID changed.');
  }
  if (nominees.reduce((sum, nominee) => sum + Number(nominee.allocationPercentage || 0), 0) > 100) {
    throw new ValidationError('Nominee allocations must not exceed 100%.');
  }
  const ids = nominees.map((nominee) => nominee.nationalId?.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new ValidationError('Each nominee must have a different National ID.');
  const result = [];
  for (const nominee of nominees) {
    const clean = { ...nominee, fullName: (nominee.fullName || '').trim(), nationalId: (nominee.nationalId || '').trim() };
    const names = clean.fullName.split(/\s+/).filter(Boolean);
    const existing = previous.find((item) => item.nationalId === clean.nationalId && item.fullName === clean.fullName && item.verificationStatus === 'VERIFIED');
    if (existing) {
      result.push({ ...clean, verificationStatus: 'VERIFIED', verifiedAt: existing.verifiedAt });
    } else if (!enabled || !clean.nationalId || names.length < 2) {
      result.push({ ...clean, verificationStatus: !enabled ? 'UNAVAILABLE' : 'DRAFT' });
    } else {
      const verification = await verify({ idNumber: clean.nationalId, documentType: 'national', firstName: names[0], surname: names[names.length - 1] });
      if (!verification.success) throw new ValidationError(`IPRS could not verify nominee ${result.length + 1}. Check the full name and National ID.`);
      result.push({ ...clean, verificationStatus: 'VERIFIED', verifiedAt: new Date().toISOString() });
    }
  }
  return result;
}

module.exports = { verifyNominees };
