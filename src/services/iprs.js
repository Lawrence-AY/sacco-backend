const iprsConfig = require('../shared/config/iprs');
const { AppError } = require('../shared/utils/errors');

let cachedToken = null;
let tokenExpiresAt = 0;

const normalizeDocumentType = (documentType) => {
  const normalized = String(documentType || 'national').trim().toLowerCase();
  return normalized === 'passport' ? 'passport' : 'national';
};

const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();

const namesMatch = (expected, actual) => {
  const left = normalizeName(expected);
  const right = normalizeName(actual);
  return Boolean(left && right && (left === right || right.includes(left) || left.includes(right)));
};

const buildUrl = (path) => `${iprsConfig.url}${path.startsWith('/') ? path : `/${path}`}`;

const unique = (items) => [...new Set(items.filter(Boolean))];

const authPaths = () => unique([
  iprsConfig.authPath,
]);

const verifyPaths = () => unique([
  iprsConfig.verifyPath,
]);

const authBodies = () => [
  { username: iprsConfig.username, password: iprsConfig.password },
  { Username: iprsConfig.username, Password: iprsConfig.password },
  { userName: iprsConfig.username, password: iprsConfig.password },
  { email: iprsConfig.username, password: iprsConfig.password },
  { grant_type: 'password', username: iprsConfig.username, password: iprsConfig.password },
];

const extractToken = (payload = {}) => (
  payload.accessToken
  || payload.access_token
  || payload.token
  || payload.jwt
  || payload.data?.accessToken
  || payload.data?.access_token
  || payload.data?.token
  || payload.result?.accessToken
  || payload.result?.access_token
  || payload.result?.token
);

const extractExpirySeconds = (payload = {}) => Number(
  payload.expiresIn
  || payload.expires_in
  || payload.expiry
  || payload.data?.expiresIn
  || payload.data?.expires_in
  || payload.result?.expiresIn
  || 3600
);

async function authenticate() {
  if (!iprsConfig.enabled) return null;
  if (!iprsConfig.url || !iprsConfig.username || !iprsConfig.password) {
    throw new Error('IPRS configuration is incomplete');
  }

  if (cachedToken && Date.now() < tokenExpiresAt - iprsConfig.tokenRefreshSkewMs) {
    return cachedToken;
  }

  let lastStatus = null;
  let networkFailed = false;

  for (const path of authPaths()) {
    for (const body of authBodies()) {
      let response;
      try {
        response = await fetch(buildUrl(path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        networkFailed = true;
        continue;
      }

      lastStatus = response.status;
      if (!response.ok) continue;

      const payload = await response.json().catch(() => ({}));
      cachedToken = extractToken(payload);
      const expiresInSeconds = extractExpirySeconds(payload);

      if (cachedToken) {
        tokenExpiresAt = Date.now() + Math.max(expiresInSeconds - 30, 60) * 1000;
        return cachedToken;
      }
    }
  }

  if (!cachedToken) {
    throw new AppError(
      networkFailed && !lastStatus
        ? 'IPRS service is unavailable. Please try again later.'
        : 'IPRS authentication failed. Please contact support.',
      networkFailed && !lastStatus ? 503 : 502,
      networkFailed && !lastStatus ? 'IPRS_UNAVAILABLE' : 'IPRS_AUTH_FAILED'
    );
  }
}

async function callVerificationApi(input, retry = true) {
  const token = await authenticate();
  const documentType = normalizeDocumentType(input.documentType);
  const body = {
    documentType,
    idNumber: input.idNumber,
    documentNumber: input.idNumber,
    firstName: input.firstName,
    surname: input.surname,
  };

  let networkFailed = false;

  for (const path of verifyPaths()) {
    let response;
    try {
      response = await fetch(buildUrl(path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      networkFailed = true;
      continue;
    }

    if (response.status === 401 && retry) {
      cachedToken = null;
      tokenExpiresAt = 0;
      return callVerificationApi(input, false);
    }

    if (!response.ok) continue;

    return response.json().catch(() => ({}));
  }

  throw new AppError(
    networkFailed
      ? 'IPRS service is unavailable. Please try again later.'
      : 'IPRS verification could not be completed. Please try again later.',
    networkFailed ? 503 : 502,
    networkFailed ? 'IPRS_UNAVAILABLE' : 'IPRS_VERIFY_FAILED'
  );
}

async function verifyIdentity({ idNumber, documentType, firstName, surname }) {
  if (!iprsConfig.enabled) {
    return { success: true, message: 'IPRS disabled; identity verification bypassed in this environment.' };
  }

  const payload = await callVerificationApi({ idNumber, documentType, firstName, surname });
  const data = payload.data || payload.result || payload;
  const apiSuccess = payload.success !== false && data.valid !== false && data.verified !== false && data.match !== false;
  const firstNameMatches = data.firstName || data.givenName ? namesMatch(firstName, data.firstName || data.givenName) : true;
  const surnameMatches = data.surname || data.lastName || data.familyName ? namesMatch(surname, data.surname || data.lastName || data.familyName) : true;
  const success = Boolean(apiSuccess && firstNameMatches && surnameMatches);

  return {
    success,
    message: success ? 'Identity details match official records.' : 'Details do not match official records.',
  };
}

module.exports = {
  authenticate,
  verifyIdentity,
  normalizeDocumentType,
};
