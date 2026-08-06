'use strict';

const { applicationDefault, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');

function usage() {
  console.error('Usage: npm run firebase:bootstrap-admin -- admin@example.com');
  process.exit(2);
}

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage();

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error('Set FIREBASE_PROJECT_ID ke project Firebase tujuan.');
  }

  const usingEmulator = Boolean(
    process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST
  );
  const app = initializeApp({
    projectId,
    ...(usingEmulator ? {} : { credential: applicationDefault() }),
  });
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const user = await auth.getUserByEmail(email);
  const lockRef = firestore.doc('system/bootstrap');

  await firestore.runTransaction(async (transaction) => {
    const lock = await transaction.get(lockRef);
    if (lock.exists && lock.data().primaryAdminUid !== user.uid) {
      throw new Error(
        `Bootstrap sudah dikunci untuk UID ${lock.data().primaryAdminUid}. ` +
        'Gunakan panel admin untuk menambah admin berikutnya.'
      );
    }
    transaction.set(lockRef, {
      primaryAdminUid: user.uid,
      email,
      status: 'pending',
      createdAt: lock.exists ? lock.data().createdAt : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  try {
    await auth.setCustomUserClaims(user.uid, {
      ...(user.customClaims || {}),
      admin: true,
    });
    await firestore.doc(`users/${user.uid}`).set({
      uid: user.uid,
      email,
      username: user.displayName || email.split('@')[0],
      usernameLower: String(user.displayName || email.split('@')[0]).toLowerCase(),
      role: 'admin',
      active: true,
      onboardingDone: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await lockRef.set({
      status: 'complete',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    await lockRef.set({
      status: 'failed',
      error: String(error?.message || error).slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    projectId,
    uid: user.uid,
    email,
    message: 'Admin pertama aktif. Logout/login ulang agar custom claim diperbarui.',
  }, null, 2));
}

main().catch((error) => {
  console.error(`Bootstrap admin gagal: ${error?.message || error}`);
  process.exitCode = 1;
});