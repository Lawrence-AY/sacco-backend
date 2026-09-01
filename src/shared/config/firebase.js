const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const requiredFirebaseVariables = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
];

const getFirebaseConfigStatus = () => ({
  configured: requiredFirebaseVariables.every((key) => Boolean(process.env[key])),
  projectId: process.env.FIREBASE_PROJECT_ID || null,
  databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
  missing: requiredFirebaseVariables.filter((key) => !process.env[key]),
});

const getFirebaseApp = () => {
  const status = getFirebaseConfigStatus();

  if (!status.configured) {
    throw new Error(`Firebase is not configured. Missing: ${status.missing.join(', ')}`);
  }

  if (getApps().length) {
    return getApps()[0];
  }

  return initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
      || `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
  });
};

const testFirebaseConnection = async () => {
  const app = getFirebaseApp();

  // Fetching a Google OAuth token verifies the service-account credentials
  // remotely without requiring a specific Firebase product to be enabled.
  const accessToken = await app.options.credential.getAccessToken();

  return {
    connected: Boolean(accessToken?.access_token),
    projectId: app.options.projectId,
    service: 'firebase-admin',
  };
};

const getFirebaseDb = () => getFirestore(getFirebaseApp(), process.env.FIRESTORE_DATABASE_ID || '(default)');
const getFirebaseStorage = () => getStorage(getFirebaseApp());

module.exports = {
  getFirebaseApp,
  getFirebaseDb,
  getFirebaseStorage,
  getFirebaseConfigStatus,
  testFirebaseConnection,
};
