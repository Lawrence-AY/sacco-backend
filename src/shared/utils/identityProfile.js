const { ValidationError } = require('./errors');

function normalizeIdentityProfile(person = {}) {
  const result = {};
  const raw = String(person.dateOfBirth || '').trim();
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  const date = slash ? `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}` : iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
  if (date) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) result.dateOfBirth = date;
  }
  const gender = String(person.gender || '').trim();
  if (gender) result.gender = ({ M: 'Male', MALE: 'Male', F: 'Female', FEMALE: 'Female' })[gender.toUpperCase()] || gender;
  return result;
}

function assertIdentityProfileUnchanged(current, changes) {
  for (const field of ['dateOfBirth', 'gender']) {
    if (current[field] && changes[field] !== undefined && changes[field] !== current[field]) {
      throw new ValidationError(`${field === 'dateOfBirth' ? 'Date of birth' : 'Gender'} `);
    }
  }
}

module.exports = { normalizeIdentityProfile, assertIdentityProfileUnchanged };
