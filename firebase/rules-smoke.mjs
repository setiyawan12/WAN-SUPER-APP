import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  increment,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  connectDatabaseEmulator,
  get,
  getDatabase,
  ref,
  set,
} from 'firebase/database';

const requireFromFunctions = createRequire(new URL('./functions/package.json', import.meta.url));
const {
  deleteApp: deleteAdminApp,
  initializeApp: initializeAdminApp,
} = requireFromFunctions('firebase-admin/app');
const { getFirestore: getAdminFirestore } = requireFromFunctions('firebase-admin/firestore');
const { getAuth: getAdminAuth } = requireFromFunctions('firebase-admin/auth');
const { getDatabase: getAdminDatabase } = requireFromFunctions('firebase-admin/database');

const projectId = process.env.GCLOUD_PROJECT || 'demo-wan-super-app';
const firebaseConfig = {
  apiKey: 'demo-key',
  authDomain: `${projectId}.firebaseapp.com`,
  projectId,
  appId: '1:123:web:rules-smoke',
  databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
};

function client(name) {
  const app = initializeApp(firebaseConfig, name);
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const database = getDatabase(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
  return { app, auth, firestore, database };
}

async function expectDenied(operation, label) {
  let denied = false;
  try {
    await operation();
  } catch (error) {
    denied = /permission|denied|PERMISSION_DENIED/i.test(`${error.code || ''} ${error.message || ''}`);
  }
  assert.equal(denied, true, `${label} seharusnya ditolak Rules`);
}

async function createClient(name) {
  const value = client(name);
  const credential = await createUserWithEmailAndPassword(
    value.auth,
    `${name}@example.test`,
    'RulesSmoke123!'
  );
  const uid = credential.user.uid;
  await setDoc(doc(value.firestore, 'users', uid), {
    uid,
    username: name,
    usernameLower: name,
    email: `${name}@example.test`,
    role: 'user',
    active: true,
  });
  return { ...value, uid };
}

const adminApp = initializeAdminApp({ projectId, databaseURL: firebaseConfig.databaseURL }, 'rules-admin');
const adminFirestore = getAdminFirestore(adminApp);
const adminAuth = getAdminAuth(adminApp);
const adminDatabase = getAdminDatabase(adminApp);

const owner = await createClient('owner');
const editor = await createClient('editor');
const outsider = await createClient('outsider');

await adminAuth.setCustomUserClaims(owner.uid, { admin: true });
await owner.auth.currentUser.getIdToken(true);

const vaultItemPath = `users/${owner.uid}/vaults/personal/items/rules-smoke-host`;
await set(ref(owner.database, vaultItemPath), {
  id: 'rules-smoke-host',
  vaultId: 'personal',
  updatedAt: Date.now(),
  payload: { ciphertext: 'encrypted-test-value' },
});
assert.equal((await get(ref(owner.database, vaultItemPath))).exists(), true);
await expectDenied(
  () => get(ref(outsider.database, vaultItemPath)),
  'Outsider membaca vault SSH user lain'
);

const vaultMetaPath = `users/${owner.uid}/vaultMeta/personal`;
await set(ref(owner.database, vaultMetaPath), {
  vaultId: 'personal',
  wrappedVaultKey: { ciphertext: 'encrypted-test-value' },
});
assert.equal((await get(ref(owner.database, vaultMetaPath))).exists(), true);
await expectDenied(
  () => set(ref(outsider.database, vaultMetaPath), { vaultId: 'personal' }),
  'Outsider menulis metadata vault SSH user lain'
);

const personalId = `${owner.uid}--ZGVmYXVsdA`;
const emptyPersonalId = `${owner.uid}--bmV3LW1pbmRtYXA`;
assert.equal((await get(ref(owner.database, `mindmaps/${emptyPersonalId}`))).exists(), false);
await expectDenied(
  () => get(ref(outsider.database, `mindmaps/${emptyPersonalId}`)),
  'Outsider membaca path mindmap personal yang belum ada'
);

await setDoc(doc(owner.firestore, 'mindmaps', personalId), {
  id: personalId,
  name: 'default',
  nameLower: 'default',
  ownerType: 'user',
  ownerId: owner.uid,
  createdBy: owner.uid,
  revision: 1,
  schemaVersion: 1,
  storageMode: 'rtdb-snapshot',
});
await set(ref(owner.database, `mindmaps/${personalId}`), {
  ownerId: owner.uid,
  projectId: 'default',
  revision: 1,
  updatedAt: Date.now(),
  updatedBy: owner.uid,
  snapshot: { nextId: 1, nodes: { seed: true }, connections: [] },
});

await expectDenied(
  () => getDoc(doc(outsider.firestore, 'mindmaps', personalId)),
  'Outsider membaca metadata personal'
);
await expectDenied(
  () => get(ref(outsider.database, `mindmaps/${personalId}`)),
  'Outsider membaca canvas personal'
);

await adminFirestore.doc(`mindmaps/${personalId}/members/${editor.uid}`).set({
  uid: editor.uid,
  permission: 'write',
  sourceShareId: 'rules-smoke',
});
await adminDatabase.ref(`mindmapAccess/${personalId}/${editor.uid}`).set({
  read: true,
  write: true,
  sourceShareId: 'rules-smoke',
});
assert.equal((await getDoc(doc(editor.firestore, 'mindmaps', personalId))).exists(), true);
assert.equal((await get(ref(editor.database, `mindmaps/${personalId}`))).exists(), true);

const groupId = 'rules-team';
await adminFirestore.doc(`groups/${groupId}`).set({
  id: groupId,
  name: 'Rules Team',
  nameLower: 'rules team',
  description: '',
  createdBy: owner.uid,
  memberCount: 2,
});
await adminFirestore.doc(`groups/${groupId}/members/${owner.uid}`).set({ uid: owner.uid, role: 'owner' });
await adminFirestore.doc(`groups/${groupId}/members/${editor.uid}`).set({ uid: editor.uid, role: 'editor' });
await adminDatabase.ref(`groupAccess/${groupId}/${owner.uid}`).set({ read: true, write: true });
await adminDatabase.ref(`groupAccess/${groupId}/${editor.uid}`).set({ read: true, write: true });

await expectDenied(
  () => getDoc(doc(outsider.firestore, 'groups', groupId)),
  'Outsider membaca metadata grup sebelum menjadi anggota'
);

const memberBatch = writeBatch(owner.firestore);
memberBatch.set(doc(owner.firestore, `groups/${groupId}/members/${outsider.uid}`), {
  uid: outsider.uid,
  role: 'viewer',
  joinedAt: serverTimestamp(),
});
memberBatch.update(doc(owner.firestore, `groups/${groupId}`), {
  memberCount: increment(1),
  updatedAt: serverTimestamp(),
});
await memberBatch.commit();
assert.equal((await getDoc(doc(outsider.firestore, `groups/${groupId}`))).exists(), true);

const groupMindmapId = `group-${groupId}--ZGVmYXVsdA`;
await setDoc(doc(editor.firestore, 'mindmaps', groupMindmapId), {
  id: groupMindmapId,
  name: 'default',
  nameLower: 'default',
  ownerType: 'group',
  ownerId: groupId,
  createdBy: editor.uid,
  revision: 1,
  schemaVersion: 1,
  storageMode: 'rtdb-snapshot',
});
await set(ref(editor.database, `mindmaps/${groupMindmapId}`), {
  ownerId: groupId,
  projectId: 'default',
  revision: 1,
  updatedAt: Date.now(),
  updatedBy: editor.uid,
  snapshot: { nextId: 1, nodes: { seed: true }, connections: [] },
});
assert.equal((await getDoc(doc(owner.firestore, 'mindmaps', groupMindmapId))).exists(), true);

console.log(JSON.stringify({
  ok: true,
  checks: [
    'SSH owner vault read/write',
    'SSH outsider denied',
    'owner empty personal path readable',
    'outsider empty personal path denied',
    'owner personal read/write',
    'outsider personal denied',
    'shared editor allowed',
    'group editor create/write',
    'group member read',
    'group outsider denied',
  ],
}, null, 2));

await Promise.all([
  deleteApp(owner.app),
  deleteApp(editor.app),
  deleteApp(outsider.app),
  deleteAdminApp(adminApp),
]);
process.exit(0);