const PAYBILL = '7929884';
const DESIGNATORS = new Set(['MS', 'LM', 'LE', 'LW', 'LD', 'SC', 'RF', 'PF']);

const memberSuffix = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  // Member numbers are issued as 29903-xxxxx. The STK reference carries
  // only the five-digit sequence after the 29903 prefix.
  const memberMatch = /^29903-(\d{5})$/.exec(raw);
  if (memberMatch) return memberMatch[1];

  // Keep accepting already-normalized values such as MS00033 and numeric
  // imports, while always emitting exactly five member digits.
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  return digits.slice(-5).padStart(5, '0');
};

const buildAccountReference = (memberNumber, designator) => {
  const code = String(designator || '').toUpperCase().replace(/^#/, '');
  const suffix = memberSuffix(memberNumber);
  if (!DESIGNATORS.has(code) || !suffix) throw new Error('A valid payment designator and member number are required');
  return `${PAYBILL}#${code}${suffix}`;
};

const parseAccountReference = (value) => {
  // KCB may omit the separator when echoing the value back in an IPN. Accept
  // both forms while always generating and displaying the canonical one.
  const match = new RegExp(`^${PAYBILL}(?:[#-])?(MS|LM|LE|LW|LD|SC|RF|PF)(\\d{5})$`, 'i').exec(String(value || '').trim());
  return match ? { designator: match[1].toUpperCase(), memberSuffix: match[2] } : null;
};

module.exports = { PAYBILL, memberSuffix, buildAccountReference, parseAccountReference };
