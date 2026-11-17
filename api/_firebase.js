const admin = require('firebase-admin');
const databaseURL = 'https://code-62406-default-rtdb.asia-southeast1.firebasedatabase.app';
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON');
  let credentials;
  try { credentials = JSON.parse(raw); } catch { throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON'); }
  admin.initializeApp({credential: admin.credential.cert(credentials), databaseURL});
}
module.exports = {admin, db: admin.database()};
