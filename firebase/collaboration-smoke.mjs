import assert from 'node:assert/strict';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { createRequire } from 'node:module';

const requireFromFunctions = createRequire(new URL('./functions/package.json', import.meta.url));
const { deleteApp: deleteAdminApp, initializeApp: initializeAdminApp } = requireFromFunctions('firebase-admin/app');
const { getAuth: getAdminAuth } = requireFromFunctions('firebase-admin/auth');
const { getFirestore: getAdminFirestore } = requireFromFunctions('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || 'demo-wan-super-app';
const firebaseConfig = {
  apiKey: 'demo-key',
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  appId: '1:123:web:collaboration-smoke',
  databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
};

function client(name) {
  const app = initializeApp(firebaseConfig, name);
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  return { app, auth, firestore };
}

async function createClient(name) {
  const value = client(name);
  const credential = await createUserWithEmailAndPassword(
    value.auth,
    `${name}@example.test`,
    'Collaboration123!'
  );
  return { ...value, uid: credential.user.uid };
}

function waitFor(label, subscribe, predicate, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`${label} tidak diterima dalam ${timeoutMs}ms`));
    }, timeoutMs);
    let unsubscribe;
    unsubscribe = subscribe(value => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(value);
    }, error => {
      clearTimeout(timeout);
      unsubscribe?.();
      reject(error);
    });
  });
}

const adminApp = initializeAdminApp({ projectId }, 'collaboration-admin');
const adminAuth = getAdminAuth(adminApp);
const adminFirestore = getAdminFirestore(adminApp);
const deviceA = await createClient('device-a');
const deviceB = await createClient('device-b');
const groupId = 'collaboration-team';
const fileId = 'default';
const fileKey = 'ZGVmYXVsdA';

await Promise.all([
  adminFirestore.doc(`groups/${groupId}`).set({
    id: groupId,
    name: 'Collaboration Team',
    createdBy: deviceA.uid,
    ownerId: deviceA.uid,
    memberCount: 2,
  }),
  adminFirestore.doc(`groups/${groupId}/members/${deviceA.uid}`).set({ uid: deviceA.uid, role: 'owner' }),
  adminFirestore.doc(`groups/${groupId}/members/${deviceB.uid}`).set({ uid: deviceB.uid, role: 'editor' }),
]);

const cursorRef = doc(deviceB.firestore, 'groups', groupId, 'collaborationFiles', fileKey, 'cursors', 'device-a-session');
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    unsubscribe();
    reject(new Error('Listener cursor device B tidak siap'));
  }, 8_000);
  const unsubscribe = onSnapshot(cursorRef, () => {
    clearTimeout(timeout);
    unsubscribe();
    resolve();
  }, reject);
});
const cursorReceived = waitFor(
  'Cursor device A',
  (next, error) => onSnapshot(cursorRef, snapshot => next(snapshot.exists() ? snapshot.data() : null), error),
  value => value?.x === 420 && value?.y === 315 && value?.uid === deviceA.uid,
);
await setDoc(doc(deviceA.firestore, 'groups', groupId, 'collaborationFiles', fileKey, 'cursors', 'device-a-session'), {
  uid: deviceA.uid,
  sessionId: 'device-a-session',
  username: 'Device A',
  color: '#7c6dfa',
  x: 420,
  y: 315,
  updatedAt: serverTimestamp(),
});
assert.equal((await cursorReceived).username, 'Device A');

const canvasRef = doc(deviceB.firestore, 'groups', groupId, 'mindmaps', fileKey);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    unsubscribe();
    reject(new Error('Listener Firestore device B tidak siap'));
  }, 8_000);
  const unsubscribe = onSnapshot(canvasRef, () => {
    clearTimeout(timeout);
    unsubscribe();
    resolve();
  }, reject);
});
const canvasReceived = waitFor(
  'Snapshot canvas device A',
  (next, error) => onSnapshot(canvasRef, snapshot => next(snapshot.exists() ? snapshot.data() : null), error),
  value => value?.revision === 1 && value?.snapshot?.nodes?.root?.text === 'Realtime',
);
await setDoc(doc(deviceA.firestore, 'groups', groupId, 'mindmaps', fileKey), {
  projectId: fileId,
  revision: 1,
  updatedBy: deviceA.uid,
  schemaVersion: 1,
  snapshot: {
    nodes: { root: { id: 'root', text: 'Realtime', x: 100, y: 100 } },
    connections: [],
    nextId: 2,
    groups: {},
    stickies: {},
    frames: {},
  },
});
assert.equal((await canvasReceived).updatedBy, deviceA.uid);

console.log(JSON.stringify({
  ok: true,
  checks: [
    'device B receives device A cursor through Firestore listener',
    'device B receives device A canvas through Firestore listener',
  ],
}, null, 2));

await Promise.all([
  deleteApp(deviceA.app),
  deleteApp(deviceB.app),
  adminAuth.deleteUser(deviceA.uid),
  adminAuth.deleteUser(deviceB.uid),
]);
await deleteAdminApp(adminApp);
process.exit(0);
