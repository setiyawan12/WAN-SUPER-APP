import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { deleteApp as deleteClientApp, initializeApp as initializeClientApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc } from "firebase/firestore";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { FirestoreKnownHostStore, knownHostDocumentId } from "../dist/src/sessions/known-host-store.js";

const projectId = process.env.GCLOUD_PROJECT || "demo-wan-super-app";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST is required");
assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST, "FIREBASE_AUTH_EMULATOR_HOST is required");

const adminApp = initializeApp({ projectId }, `wan-ssh-known-host-${randomUUID()}`);
const firestore = getAdminFirestore(adminApp);
const firstStore = new FirestoreKnownHostStore(firestore);
const identity = { tenantId: "tenant-a", host: "Server.Example.COM.", port: 22 };
const otherTenant = { ...identity, tenantId: "tenant-b" };

let clientApp;
try {
  assert.equal(await firstStore.accept(identity, {
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:first"
  }, "firebase:actor-a"), "accepted");

  const persisted = await firstStore.get({ ...identity, host: "server.example.com" });
  assert.equal(persisted?.version, 1);
  assert.equal(persisted?.fingerprint, "SHA256:first");
  assert.equal(await firstStore.get(otherTenant), undefined);

  const secondStore = new FirestoreKnownHostStore(getAdminFirestore(adminApp));
  assert.equal((await secondStore.get(identity))?.fingerprint, "SHA256:first");

  const concurrent = await Promise.all([
    firstStore.accept(identity, { algorithm: "ssh-ed25519", fingerprint: "SHA256:second-a" }, "firebase:actor-a", 1),
    secondStore.accept(identity, { algorithm: "ssh-ed25519", fingerprint: "SHA256:second-b" }, "firebase:actor-b", 1)
  ]);
  assert.deepEqual(concurrent.sort(), ["accepted", "conflict"]);
  const latest = await firstStore.get(identity);
  assert.equal(latest?.version, 2);
  assert.match(latest?.fingerprint ?? "", /^SHA256:second-[ab]$/);

  const reference = firestore.collection("wanSshKnownHosts").doc(knownHostDocumentId(identity));
  const audit = await reference.collection("audit").orderBy("version").get();
  assert.equal(audit.size, 2);
  assert.deepEqual(audit.docs.map((entry) => entry.data().version), [1, 2]);
  assert.equal(audit.docs[1].data().fromFingerprint, "SHA256:first");

  clientApp = initializeClientApp({
    apiKey: "demo-key",
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
    appId: "1:123:web:wan-ssh-known-host"
  }, `wan-ssh-known-host-client-${randomUUID()}`);
  const auth = getAuth(clientApp);
  const clientFirestore = getFirestore(clientApp);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(clientFirestore, "127.0.0.1", 8080);
  await createUserWithEmailAndPassword(auth, `known-host-${randomUUID()}@example.test`, "KnownHost123!");
  const clientReference = doc(clientFirestore, "wanSshKnownHosts", knownHostDocumentId(identity));
  await expectDenied(() => getDoc(clientReference), "direct client read");
  await expectDenied(() => setDoc(clientReference, { fingerprint: "SHA256:attacker" }), "direct client write");

  process.stdout.write("WAN SSH Firestore known-host Emulator E2E passed: persistence, tenant isolation, CAS conflict, audit, and direct-client denial.\n");
} finally {
  if (clientApp) await deleteClientApp(clientApp);
  await firestore.recursiveDelete(firestore.collection("wanSshKnownHosts"));
  await deleteApp(adminApp);
}

async function expectDenied(operation, label) {
  await assert.rejects(operation, (error) => {
    assert.match(`${error?.code ?? ""} ${error?.message ?? ""}`, /permission|denied|PERMISSION_DENIED/i, label);
    return true;
  });
}