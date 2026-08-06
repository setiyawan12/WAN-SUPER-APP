import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const requireFromFunctions = createRequire(new URL('./functions/package.json', import.meta.url));
const { initializeApp } = requireFromFunctions('firebase-admin/app');
const { getAuth } = requireFromFunctions('firebase-admin/auth');
const { getFirestore } = requireFromFunctions('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || 'demo-wan-super-app';
const app = initializeApp({ projectId }, 'bootstrap-smoke');
const auth = getAuth(app);
const firestore = getFirestore(app);
const node = process.execPath;
const script = new URL('./functions/bootstrap-admin.js', import.meta.url).pathname;
const env = {
  ...process.env,
  FIREBASE_PROJECT_ID: projectId,
};

const primary = await auth.createUser({
  email: 'primary-admin@example.test',
  password: 'Bootstrap123!',
  displayName: 'Primary Admin',
});
const secondary = await auth.createUser({
  email: 'secondary-admin@example.test',
  password: 'Bootstrap123!',
  displayName: 'Secondary Admin',
});

await execFileAsync(node, [script, primary.email], { env });
const primaryAfter = await auth.getUser(primary.uid);
assert.equal(primaryAfter.customClaims?.admin, true, 'Primary admin claim harus aktif');
assert.equal((await firestore.doc(`users/${primary.uid}`).get()).data()?.role, 'admin');
assert.equal((await firestore.doc('system/bootstrap').get()).data()?.status, 'complete');

await execFileAsync(node, [script, primary.email], { env });

let secondDenied = false;
try {
  await execFileAsync(node, [script, secondary.email], { env });
} catch (error) {
  secondDenied = /Bootstrap sudah dikunci/.test(`${error.stderr || ''} ${error.message || ''}`);
}
assert.equal(secondDenied, true, 'Bootstrap admin kedua harus ditolak');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'primary admin promoted',
    'profile role synchronized',
    'same-user retry idempotent',
    'second bootstrap denied',
  ],
}, null, 2));
