import type { Host } from "./types";

const noop = () => () => {};
const hostId = "0e40c778-80b2-4c70-a31b-510ce7566640";
const hostId2 = "31841946-21ab-44e3-b54c-88a1d284d085";

const demoHosts: Host[] = [
  {
    id: hostId,
    vaultId: "local",
    groupId: null,
    label: "API Production",
    address: "api.internal.example",
    port: 22,
    protocol: "ssh",
    identityId: null,
    keyId: null,
    jumpHostId: null,
    startupSnippetId: null,
    tags: ["api", "primary"],
    environment: "prod",
    favorite: true,
    agentForwarding: false,
    autoReconnect: true,
    reconnectLimit: 3,
    keepAliveInterval: 30,
    lastConnectedAt: Date.now() - 900_000,
    effectiveUsername: "deploy",
    effectivePort: 22,
    hasCredential: true,
    groupPath: ["Production"]
  },
  {
    id: hostId2,
    vaultId: "personal",
    groupId: null,
    label: "Worker Staging",
    address: "10.20.0.18",
    port: 22,
    protocol: "ssh",
    identityId: null,
    keyId: null,
    jumpHostId: hostId,
    startupSnippetId: null,
    tags: ["worker"],
    environment: "staging",
    favorite: false,
    agentForwarding: false,
    autoReconnect: true,
    reconnectLimit: 3,
    keepAliveInterval: 30,
    lastConnectedAt: Date.now() - 86_400_000,
    effectiveUsername: "ubuntu",
    effectivePort: 22,
    hasCredential: true,
    groupPath: ["Staging"]
  }
];

const mockApi: any = {
  vault: {
    status: async () => ({ state: "unlocked" }),
    create: async () => undefined,
    unlock: async () => undefined,
    lock: async () => undefined,
    changePassword: async () => undefined,
    settings: async () => ({ autoLockMs: 900_000, biometricAvailable: true }),
    setAutoLock: async (autoLockMs: number) => ({ autoLockMs, biometricAvailable: true }),
    tryBiometricUnlock: async () => true,
    enableBiometric: async () => undefined,
    biometricAvailable: async () => true
  },
  hosts: {
    list: async () => demoHosts,
    get: async (id: string) => demoHosts.find((host) => host.id === id) ?? null,
    revealPassword: async () => ({ password: "demo-password" }),
    save: async (input: any) => input.id ?? crypto.randomUUID(),
    remove: async () => undefined,
    restoreDeleted: async () => ({ restored: false }),
    testConnection: async () => ({ ok: true, latencyMs: 68 })
  },
  knownHosts: {
    list: async () => [{ id: crypto.randomUUID(), vaultId: "local", hostPattern: "api.internal.example:22", keyType: "ssh-ed25519", fingerprint: "SHA256:8F6xdemoFingerprint", firstSeenAt: Date.now(), updatedAt: Date.now() }],
    remove: async () => undefined
  },
  storage: { status: async () => ({ needed: false, schemaVersion: 2, backups: [] }), acknowledgeRecovery: async () => undefined },
  groups: { list: async () => [], save: async () => crypto.randomUUID(), remove: async () => undefined },
  identities: { list: async () => [], save: async () => crypto.randomUUID(), remove: async () => undefined },
  sync: {
    status: async () => ({ state: "idle", pending: 0, configured: true, user: "operator@wan.dev" }),
    now: async () => ({ ok: true }),
    pushAll: async () => ({ ok: true }),
    signIn: async () => ({ uid: "demo" }),
    signInGoogle: async () => ({ uid: "demo" }),
    signOut: async () => ({ ok: true }),
    importConfig: async () => ({ configured: true })
  },
  keys: { list: async () => [], generate: async () => crypto.randomUUID(), importPem: async () => crypto.randomUUID(), exportPublic: async () => "ssh-ed25519 AAAA", pushToHost: async () => undefined, remove: async () => undefined },
  snippets: { list: async () => [], save: async () => crypto.randomUUID(), remove: async () => undefined, run: async () => undefined },
  session: {
    open: async () => ({ sessionId: crypto.randomUUID() }),
    openLocal: async () => ({ sessionId: crypto.randomUUID(), pty: true }),
    reconnect: async ({ sessionId }: any) => ({ sessionId }),
    write: () => undefined,
    resize: () => undefined,
    close: async () => undefined,
    answerAuthPrompt: async () => undefined,
    answerHostKey: async () => undefined
  },
  transfer: { home: async () => "/home/deploy", list: async () => [], upload: async () => [], uploadDropped: async () => [], download: async () => null, mkdir: async () => undefined, rename: async () => undefined, remove: async () => undefined, jobs: async () => [], retry: async () => true, cancel: async () => true },
  tunnels: { list: async () => [], start: async (input: any) => ({ ...input, id: crypto.randomUUID(), state: "active", bindPort: input.bindPort || 8080 }), stop: async () => true },
  diagnostics: { run: async () => ({ hostId, address: "api.internal.example", port: 22, ok: true, checkedAt: Date.now(), phases: [{ name: "resolve", ok: true, durationMs: 7, detail: "10.0.0.12" }, { name: "tcp", ok: true, durationMs: 18, detail: "TCP ready" }, { name: "ssh", ok: true, durationMs: 43, detail: "Authentication ready" }] }) },
  openSsh: { importConfig: async () => ({ canceled: false, imported: 2, updated: 0, identityFilesSkipped: ["~/.ssh/id_ed25519"], warnings: ["Demo import completed"] }) },
  audit: { list: async () => [] },
  recording: { status: async () => null, start: async (input: any) => ({ ...input, startedAt: Date.now() }), stop: async () => ({ saved: true }), discard: async () => true },
  on: {
    termOutput: noop,
    termExit: noop,
    sessionState: noop,
    hostKeyPrompt: noop,
    authPrompt: noop,
    transferProgress: noop,
    tunnelChanged: noop,
    storeChanged: noop,
    vaultLocked: noop,
    syncState: noop
  }
};

const preloadWindow = window as Window & { api?: any };

export const bridgeUnavailable = !preloadWindow.api && !import.meta.env.DEV;
export const isMockApi = !preloadWindow.api && import.meta.env.DEV;
export const api: any = preloadWindow.api ?? (isMockApi ? mockApi : undefined);