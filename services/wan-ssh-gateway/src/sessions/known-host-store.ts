import { createHash, randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

export interface KnownHostIdentity {
  tenantId: string;
  host: string;
  port: number;
}

export interface KnownHostRecord extends KnownHostIdentity {
  algorithm: string;
  fingerprint: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface KnownHostStore {
  get(identity: KnownHostIdentity): Promise<KnownHostRecord | undefined>;
  list?(tenantId: string): Promise<KnownHostRecord[]>;
  accept(
    identity: KnownHostIdentity,
    observed: { algorithm: string; fingerprint: string },
    actorId: string,
    expectedVersion?: number
  ): Promise<"accepted" | "conflict">;
  remove?(identity: KnownHostIdentity, actorId: string): Promise<boolean>;
}

export function normalizeKnownHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

export function knownHostDocumentId(identity: KnownHostIdentity) {
  return createHash("sha256")
    .update(`${identity.tenantId}\0${normalizeKnownHost(identity.host)}\0${identity.port}`)
    .digest("hex");
}

export class FirestoreKnownHostStore implements KnownHostStore {
  constructor(private readonly firestore: Firestore) {}

  async get(identity: KnownHostIdentity) {
    const snapshot = await this.document(identity).get();
    return snapshot.exists ? snapshot.data() as KnownHostRecord : undefined;
  }

  async list(tenantId: string) {
    const snapshot = await this.firestore.collection("wanSshKnownHosts").where("tenantId", "==", tenantId).get();
    return snapshot.docs.map((document) => document.data() as KnownHostRecord).sort((left, right) => left.host.localeCompare(right.host) || left.port - right.port);
  }

  async accept(
    identity: KnownHostIdentity,
    observed: { algorithm: string; fingerprint: string },
    actorId: string,
    expectedVersion?: number
  ) {
    return this.firestore.runTransaction(async (transaction) => {
      const reference = this.document(identity);
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists ? snapshot.data() as KnownHostRecord : undefined;
      if ((current?.version ?? undefined) !== expectedVersion) return "conflict" as const;

      const now = new Date().toISOString();
      const record: KnownHostRecord = {
        tenantId: identity.tenantId,
        host: normalizeKnownHost(identity.host),
        port: identity.port,
        algorithm: observed.algorithm,
        fingerprint: observed.fingerprint,
        version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        createdBy: current?.createdBy ?? actorId,
        updatedAt: now,
        updatedBy: actorId
      };
      transaction.set(reference, record);
      transaction.set(reference.collection("audit").doc(randomUUID()), {
        actorId,
        changedAt: now,
        fromAlgorithm: current?.algorithm ?? null,
        fromFingerprint: current?.fingerprint ?? null,
        toAlgorithm: observed.algorithm,
        toFingerprint: observed.fingerprint,
        version: record.version
      });
      return "accepted" as const;
    });
  }

  async remove(identity: KnownHostIdentity, actorId: string) {
    return this.firestore.runTransaction(async (transaction) => {
      const reference = this.document(identity);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return false;
      const current = snapshot.data() as KnownHostRecord;
      transaction.set(reference.collection("audit").doc(randomUUID()), {
        actorId,
        changedAt: new Date().toISOString(),
        fromAlgorithm: current.algorithm,
        fromFingerprint: current.fingerprint,
        toAlgorithm: null,
        toFingerprint: null,
        version: current.version + 1,
        action: "revoked"
      });
      transaction.delete(reference);
      return true;
    });
  }

  private document(identity: KnownHostIdentity) {
    return this.firestore.collection("wanSshKnownHosts").doc(knownHostDocumentId(identity));
  }
}