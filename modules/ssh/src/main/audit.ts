import * as node_crypto from "node:crypto";
import { settingsStore } from "./store.js";
import type { VaultCore } from "./vault.js";

const AUDIT_KEY = "encryptedAuditLog";
const MAX_AUDIT_ENTRIES = 500;
const SENSITIVE_KEY = /(?:password|passphrase|token|secret|api.?key|private.?key|authorization|credential|pem)/i;

function sanitize(value: any, key = "", depth = 0): any {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, "", depth + 1));
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, "", depth + 1) };
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([itemKey, itemValue]) => [itemKey, sanitize(itemValue, itemKey, depth + 1)])
    );
  }
  return String(value);
}

export class AuditService {
  vault: VaultCore;

  constructor(vault: VaultCore) {
    this.vault = vault;
  }

  record(action: string, detail: any = {}, outcome: "success" | "failure" = "success") {
    if (!this.vault.isUnlocked()) return null;
    const id = node_crypto.randomUUID();
    const timestamp = Date.now();
    const envelope = this.vault.encryptField(
      JSON.stringify({ action, outcome, detail: sanitize(detail) }),
      id,
      "audit"
    );
    const entries = settingsStore.get(AUDIT_KEY, []);
    const next = Array.isArray(entries) ? entries.slice(-(MAX_AUDIT_ENTRIES - 1)) : [];
    next.push({ id, timestamp, envelope });
    settingsStore.set(AUDIT_KEY, next);
    return id;
  }

  list(limit = 100) {
    const entries = settingsStore.get(AUDIT_KEY, []);
    if (!Array.isArray(entries)) return [];
    return entries.slice(-Math.max(1, Math.min(limit, 500))).reverse().flatMap((entry: any) => {
      try {
        const payload = JSON.parse(this.vault.decryptString(entry.envelope, entry.id));
        return [{ id: entry.id, timestamp: entry.timestamp, ...payload }];
      } catch {
        return [{ id: entry.id, timestamp: entry.timestamp, action: "unreadable", outcome: "failure", detail: {} }];
      }
    });
  }
}