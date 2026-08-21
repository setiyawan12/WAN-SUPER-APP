import type { RemoteEntry, TransferJob, Tunnel } from "./types";
import type { SshTransportEvent, WebSessionOpenInput } from "./transport/contract";
import { WebSocketRemoteTerminalTransport } from "./transport/web-socket";
import { getKnownHost, listKnownHosts, removeKnownHost, saveKnownHost } from "./web-known-hosts";
import { WebCloudStore } from "./web-cloud-store";
import { WebVault, type CloudVaultMeta, type VaultEnvelope } from "./web-vault";

type Item = Record<string, any> & { id: string; type: string; ownerUid: string; vaultId: "personal"; version: number; updatedAt: number; deletedAt: number | null };
type EventName = "termOutput" | "termExit" | "sessionState" | "hostKeyPrompt" | "authPrompt" | "transferProgress" | "tunnelChanged" | "storeChanged" | "vaultLocked" | "syncState";
type Listener = (payload: any) => void;
type SessionRecord = { hostId: string; cols: number; rows: number };
type TransferRecord = TransferJob & { file?: File; remotePath?: string; canceled?: boolean };
type Recording = { sessionId: string; startedAt: number; bytes: number; lines: string[]; truncated: boolean };

const PERSONAL = "personal" as const;
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const TRANSFER_CHUNK_BYTES = 128 * 1024;
const SECRET_PATTERN = /((?:password|passphrase|token|secret|api[_-]?key)\s*[:=]\s*)([^\s\r\n]+)/gi;

function groupChain(host: Item, get: (id: string) => Item | null) {
  const chain: Item[] = [];
  const seen = new Set<string>();
  let groupId = host.groupId as string | null;
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId);
    const group = get(groupId);
    if (!group || group.type !== "group") break;
    chain.push(group);
    groupId = group.parentId ?? null;
  }
  return chain;
}

function resolveEffective(host: Item, get: (id: string) => Item | null) {
  const chain = groupChain(host, get);
  const nearest = (pick: (defaults: Record<string, any>) => any) => {
    for (const group of chain) {
      const value = pick(group.defaults ?? {});
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  };
  const identityOf = (id?: string | null) => {
    const entity = id ? get(id) : null;
    return entity?.type === "identity" ? entity : null;
  };
  const hostIdentity = identityOf(host.identityId);
  const groupIdentityId = nearest((defaults) => defaults.identityId) ?? null;
  const groupIdentity = identityOf(groupIdentityId);
  const identity = hostIdentity ?? groupIdentity;
  const username = hostIdentity?.username ?? nearest((defaults) => defaults.username) ?? identity?.username ?? null;
  const port = host.port ?? nearest((defaults) => defaults.port) ?? null;
  const identityId = host.identityId ?? groupIdentityId;
  const keyId = host.keyId ?? hostIdentity?.keyId ?? nearest((defaults) => defaults.keyId) ?? groupIdentity?.keyId ?? null;
  const environment: Record<string, string> = {};
  for (let index = chain.length - 1; index >= 0; index -= 1) Object.assign(environment, chain[index].defaults?.envVars ?? {});
  return { username, port, identityId, keyId, environment, groupPath: chain.map((group) => group.name).reverse() };
}

function resolveJumpChain(host: Item, get: (id: string) => Item | null) {
  const chain: Item[] = [];
  const seen = new Set([host.id]);
  let jumpHostId = host.jumpHostId as string | null;
  while (jumpHostId) {
    if (seen.has(jumpHostId)) throw new Error("Jump host chain contains a cycle");
    if (chain.length >= 5) throw new Error("A maximum of five jump hosts is supported");
    seen.add(jumpHostId);
    const jumpHost = get(jumpHostId);
    if (!jumpHost || jumpHost.type !== "host") throw new Error("Jump host was not found");
    chain.push(jumpHost);
    jumpHostId = jumpHost.jumpHostId ?? null;
  }
  return chain.reverse();
}

function remoteJoin(directory: string, name: string) {
  return `${directory.replace(/\/$/, "")}/${name}`.replace(/^$/, "/");
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export class WebCloudApi {
  private readonly vaultCore = new WebVault();
  private readonly listeners = new Map<EventName, Set<Listener>>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly sessionStates = new Map<string, { state: string; error?: Error }>();
  private readonly connectionWaiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void; timeout: number }>>();
  private readonly transferJobs = new Map<string, TransferRecord>();
  private readonly activeTunnels = new Map<string, Tunnel>();
  private readonly recordings = new Map<string, Recording>();
  private readonly promptHosts = new Map<string, Extract<SshTransportEvent, { type: "hostkey.prompt" }>>();
  private readonly knownHostEntries = new Map<string, { host: string; port: number; browser: boolean }>();
  private autoLockMs = 15 * 60_000;
  private autoLockTimer?: number;
  private transportOff: () => void;
  private storeOff: () => void;

  constructor(
    private readonly store: WebCloudStore,
    readonly transport: WebSocketRemoteTerminalTransport,
    private readonly userLabel: string,
    private readonly onSignOut: () => Promise<void>
  ) {
    this.transportOff = transport.onEvent((event) => this.handleTransportEvent(event));
    this.storeOff = store.onChange(() => {
      if (this.vaultCore.unlocked) this.emit("storeChanged");
      this.emit("syncState", { state: "idle", pending: 0 });
    });
  }

  async initialize() {
    await this.store.ready();
  }

  dispose() {
    window.clearTimeout(this.autoLockTimer);
    this.transportOff();
    this.storeOff();
    this.transport.dispose();
    this.store.dispose();
    this.vaultCore.lock();
  }

  readonly vault = {
    status: async () => {
      await this.store.ready();
      return { state: this.vaultCore.unlocked ? "unlocked" : this.store.meta() ? "locked" : "no-vault" };
    },
    create: async (password: string) => {
      if (this.store.meta()) throw new Error("Cloud vault already exists");
      const meta = await this.vaultCore.create(password);
      await this.store.saveMeta(meta);
      this.touch();
    },
    unlock: async (password: string) => {
      const meta = this.requireMeta();
      await this.vaultCore.unlock(password, meta);
      this.touch();
    },
    lock: async () => this.lock(),
    changePassword: async (oldPassword: string, newPassword: string) => {
      const next = await this.vaultCore.changePassword(oldPassword, newPassword, this.requireMeta());
      await this.store.saveMeta(next);
      this.touch();
    },
    settings: async () => ({ autoLockMs: this.autoLockMs, biometricAvailable: false }),
    setAutoLock: async (milliseconds: number) => {
      this.autoLockMs = milliseconds;
      this.touch();
      return { autoLockMs: this.autoLockMs, biometricAvailable: false };
    },
    tryBiometricUnlock: async () => false,
    enableBiometric: async () => { throw new Error("Device biometric unlock is unavailable in the browser"); },
    biometricAvailable: async () => false
  };

  readonly hosts = {
    list: async () => {
      await this.readyUnlocked();
      return this.store.list<Item>("host").map((host) => this.hostView(host));
    },
    get: async (id: string) => {
      await this.readyUnlocked();
      const host = this.item(id);
      return host?.type === "host" ? this.hostView(host) : null;
    },
    revealPassword: async (input: { id: string; password?: string; biometric?: boolean }) => {
      await this.readyUnlocked();
      if (input.biometric) throw new Error("Browser biometric reauthentication is unavailable");
      if (!input.password || !await this.vaultCore.verifyPassword(input.password, this.requireMeta())) throw new Error("Master password is incorrect");
      const host = this.requireItem(input.id, "host");
      const effective = resolveEffective(host, (id) => this.item(id));
      const identity = effective.identityId ? this.item(effective.identityId) : null;
      return { password: identity?.secret ? await this.vaultCore.decryptString(identity.secret, identity.id) : null };
    },
    save: async (input: any) => this.saveHost(input),
    remove: async (id: string) => { await this.store.remove(id); await this.auditRecord("host:remove", { hostId: id }); },
    restoreDeleted: async () => ({ restored: false }),
    testConnection: async (id: string) => this.testConnection(id)
  };

  readonly groups = {
    list: async () => {
      await this.readyUnlocked();
      return this.store.list<Item>("group").map((group) => ({ id: group.id, parentId: group.parentId ?? null, name: group.name, defaults: group.defaults ?? {} }));
    },
    save: async (input: any) => {
      await this.readyUnlocked();
      const existing = input.id ? this.item(input.id) : null;
      const id = existing?.id ?? crypto.randomUUID();
      const parentId = input.parentId !== undefined ? input.parentId : existing?.parentId ?? null;
      let cursor = parentId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === id) throw new Error("Parent group contains a cycle");
        seen.add(cursor);
        cursor = this.item(cursor)?.parentId ?? null;
      }
      const group = this.entity(existing, id, "group", { parentId, name: input.name, defaults: input.defaults ?? existing?.defaults ?? {} });
      await this.store.upsert(group, existing?.version ?? 0);
      await this.auditRecord("group:save", { groupId: id });
      return id;
    },
    remove: async (id: string) => { await this.store.remove(id); await this.auditRecord("group:remove", { groupId: id }); }
  };

  readonly identities = {
    list: async () => {
      await this.readyUnlocked();
      return this.store.list<Item>("identity").map((identity) => ({ id: identity.id, vaultId: PERSONAL, label: identity.label, username: identity.username, keyId: identity.keyId ?? null, hasSecret: Boolean(identity.secret) }));
    },
    save: async (input: any) => {
      await this.readyUnlocked();
      const existing = input.id ? this.item(input.id) : null;
      const id = existing?.id ?? crypto.randomUUID();
      const secret = input.password ? await this.vaultCore.encryptString(input.password, id, "secret") : existing?.secret ?? null;
      const identity = this.entity(existing, id, "identity", { label: input.label, username: input.username, secret, keyId: input.keyId ?? existing?.keyId ?? null });
      await this.store.upsert(identity, existing?.version ?? 0);
      await this.auditRecord("identity:save", { identityId: id });
      return id;
    },
    remove: async (id: string) => { await this.store.remove(id); await this.auditRecord("identity:remove", { identityId: id }); }
  };

  readonly keys = {
    list: async () => {
      await this.readyUnlocked();
      return this.store.list<Item>("sshkey").map((key) => ({ id: key.id, label: key.label, algorithm: key.algorithm, bits: key.bits ?? null, publicKey: key.publicKey ?? "", fingerprintSha256: key.fingerprintSha256 ?? "", source: key.source ?? "imported" }));
    },
    generate: async (input: any) => {
      await this.readyUnlocked();
      const generated = await this.transport.generateKey(input);
      return this.persistKey(input.label, generated, input.passphrase, "generated");
    },
    importPem: async (input: any) => {
      await this.readyUnlocked();
      const inspected = await this.transport.inspectKey({ privateKey: input.pem, passphrase: input.passphrase });
      return this.persistKey(input.label, { ...inspected, privateKey: input.pem }, input.passphrase, "imported");
    },
    exportPublic: async (id: string) => this.requireItem(id, "sshkey").publicKey || "(public key unavailable)",
    pushToHost: async (keyId: string, hostId: string) => {
      const key = this.requireItem(keyId, "sshkey");
      const { sessionId } = await this.openHostSession(hostId, 80, 24, false);
      try {
        await this.waitConnected(sessionId);
        await this.transport.installKey(sessionId, key.publicKey);
        await this.auditRecord("key:install", { keyId, hostId });
      } finally {
        await this.closeSession(sessionId);
      }
    },
    remove: async (id: string) => { await this.store.remove(id); await this.auditRecord("key:remove", { keyId: id }); }
  };

  readonly snippets = {
    list: async () => {
      await this.readyUnlocked();
      return this.store.list<Item>("snippet").map((snippet) => ({ id: snippet.id, vaultId: PERSONAL, label: snippet.label, command: snippet.command, description: snippet.description ?? "", tags: snippet.tags ?? [], updatedAt: snippet.updatedAt }));
    },
    save: async (input: any) => {
      await this.readyUnlocked();
      const existing = input.id ? this.item(input.id) : null;
      const id = existing?.id ?? crypto.randomUUID();
      const snippet = this.entity(existing, id, "snippet", { label: input.label, command: input.command, description: input.description ?? existing?.description ?? "", tags: input.tags ?? existing?.tags ?? [] });
      await this.store.upsert(snippet, existing?.version ?? 0);
      return id;
    },
    remove: async (id: string) => this.store.remove(id),
    run: async (input: { sessionId: string; snippetId: string; appendNewline?: boolean }) => {
      const snippet = this.requireItem(input.snippetId, "snippet");
      this.transport.write(input.sessionId, `${snippet.command}${input.appendNewline === false ? "" : "\r"}`);
    }
  };

  readonly session = {
    open: async (input: { hostId: string; cols: number; rows: number }) => this.openHostSession(input.hostId, input.cols, input.rows, true),
    openLocal: async () => { throw new Error("Local shell is unavailable in WAN SSH Web"); },
    reconnect: async (input: { sessionId: string; cols: number; rows: number }) => {
      const previous = this.sessions.get(input.sessionId);
      if (!previous) throw new Error("Session was not found");
      await this.closeSession(input.sessionId);
      return this.openHostSession(previous.hostId, input.cols, input.rows, true);
    },
    write: (sessionId: string, data: string) => this.transport.write(sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => this.transport.resize(sessionId, cols, rows),
    close: async (sessionId: string) => this.closeSession(sessionId),
    answerAuthPrompt: async (sessionId: string, answers: string[]) => this.transport.answerAuthPrompt(sessionId, answers),
    answerHostKey: async (sessionId: string, accept: boolean) => {
      const prompt = this.promptHosts.get(sessionId);
      if (accept && prompt) await saveKnownHost({ host: prompt.host, port: prompt.port, algorithm: prompt.algorithm, fingerprint: prompt.fingerprint }).catch(() => undefined);
      this.promptHosts.delete(sessionId);
      this.transport.answerHostKey(sessionId, accept);
    }
  };

  readonly transfer = {
    home: async (sessionId: string) => this.transport.sftpHome(sessionId),
    list: async (input: { sessionId: string; path: string }) => this.transport.sftpList(input.sessionId, input.path) as Promise<RemoteEntry[]>,
    upload: async (input: { sessionId: string; remoteDirectory: string; resume?: boolean }) => {
      const files = await this.pickFiles();
      return this.enqueueUploads(input.sessionId, input.remoteDirectory, files, input.resume !== false);
    },
    uploadDropped: async (sessionId: string, remoteDirectory: string, files: FileList | File[], resume = true) => this.enqueueUploads(sessionId, remoteDirectory, Array.from(files), resume),
    download: async (input: { sessionId: string; remotePath: string; resume?: boolean }) => this.enqueueDownload(input.sessionId, input.remotePath),
    mkdir: async (input: { sessionId: string; path: string }) => this.transport.sftpMkdir(input.sessionId, input.path),
    rename: async (input: { sessionId: string; from: string; to: string }) => this.transport.sftpRename(input.sessionId, input.from, input.to),
    remove: async (input: { sessionId: string; path: string; directory: boolean }) => this.transport.sftpRemove(input.sessionId, input.path, input.directory),
    jobs: async () => [...this.transferJobs.values()].map(({ file: _file, remotePath: _remotePath, canceled: _canceled, ...job }) => job),
    retry: async (id: string) => this.retryTransfer(id),
    cancel: async (id: string) => {
      const job = this.transferJobs.get(id);
      if (!job) return false;
      job.canceled = true;
      job.state = "canceled";
      this.publishTransfer(job);
      return true;
    }
  };

  readonly tunnels = {
    list: async (sessionId?: string) => [...this.activeTunnels.values()].filter((tunnel) => !sessionId || tunnel.sessionId === sessionId),
    start: async (input: any) => {
      if (input.kind !== "remote") throw new Error("WAN SSH Web supports remote forwarding only");
      const tunnels = await this.transport.tunnelStart({ ...input, bindAddress: input.bindAddress || "127.0.0.1" }) as Tunnel[];
      this.replaceSessionTunnels(input.sessionId, tunnels);
      return tunnels.at(-1);
    },
    stop: async (id: string) => {
      const tunnel = this.activeTunnels.get(id);
      if (!tunnel) return false;
      const tunnels = await this.transport.tunnelStop(tunnel.sessionId, id) as Tunnel[];
      this.replaceSessionTunnels(tunnel.sessionId, tunnels);
      return true;
    }
  };

  readonly diagnostics = {
    run: async (hostId: string) => {
      const host = this.requireItem(hostId, "host");
      const jumps = resolveJumpChain(host, (id) => this.item(id));
      const probe = jumps[0] ?? host;
      const effectiveProbe = resolveEffective(probe, (id) => this.item(id));
      const result = await this.transport.diagnostics(
        { host: probe.address, port: effectiveProbe.port ?? 22 },
        host.useLocalAgent ? { mode: "client-agent" } : undefined
      );
      const started = Date.now();
      const tested = await this.testConnection(hostId);
      const phases = [...result.phases, { name: "ssh", ok: tested.ok, durationMs: Date.now() - started, detail: tested.ok ? `Authentication and shell ready (${tested.latencyMs} ms)` : tested.error ?? "SSH failed" }];
      return { hostId, address: host.address, port: resolveEffective(host, (id) => this.item(id)).port ?? 22, ok: phases.every((phase: any) => phase.ok), checkedAt: Date.now(), phases };
    }
  };

  readonly knownHosts = {
    list: async () => {
      const gateway = await this.transport.knownHosts().catch(() => []);
      const browser = await listKnownHosts().catch(() => []);
      this.knownHostEntries.clear();
      const entries = gateway.length ? gateway.map((entry: any) => {
        const separator = String(entry.hostPattern).lastIndexOf(":");
        const host = String(entry.hostPattern).slice(0, separator);
        const port = Number(String(entry.hostPattern).slice(separator + 1));
        this.knownHostEntries.set(String(entry.id), { host, port, browser: false });
        return entry;
      }) : browser.map((entry) => {
        this.knownHostEntries.set(entry.key, { host: entry.host, port: entry.port, browser: true });
        return { id: entry.key, vaultId: PERSONAL, hostPattern: `${entry.host}:${entry.port}`, keyType: entry.algorithm, fingerprint: entry.fingerprint, firstSeenAt: entry.firstSeenAt, updatedAt: entry.updatedAt };
      });
      return entries;
    },
    remove: async (id: string) => {
      const entry = this.knownHostEntries.get(id);
      if (!entry) return false;
      if (entry.browser) await removeKnownHost(id);
      else await this.transport.removeKnownHost(entry.host, entry.port);
      this.knownHostEntries.delete(id);
      return true;
    }
  };

  readonly storage = { status: async () => ({ schemaVersion: 1, backups: [], needed: false }), acknowledgeRecovery: async () => undefined };
  readonly openSsh = { importConfig: async () => { throw new Error("OpenSSH filesystem import is unavailable in the browser"); } };
  readonly audit = { list: async (limit = 100) => this.auditList(limit) };
  readonly sync = {
    status: async () => ({ state: "idle", pending: 0, configured: true, user: this.userLabel }),
    now: async () => ({ ok: true, pushed: 0, pulled: 0 }),
    pushAll: async () => ({ ok: true, requeued: 0 }),
    signIn: async () => { throw new Error("The web workspace already uses Firebase Authentication"); },
    signInGoogle: async () => { throw new Error("The web workspace already uses Firebase Authentication"); },
    signOut: async () => this.onSignOut(),
    importConfig: async () => ({ configured: true })
  };

  readonly recording = {
    status: async (sessionId?: string) => sessionId ? this.recordings.get(sessionId) ?? null : [...this.recordings.values()],
    start: async (input: { sessionId: string; cols: number; rows: number }) => {
      if (this.recordings.has(input.sessionId)) throw new Error("Recording is already active");
      const startedAt = Date.now();
      const header = JSON.stringify({ version: 2, width: input.cols, height: input.rows, timestamp: Math.floor(startedAt / 1_000), env: { TERM: "xterm-256color", SHELL: "ssh-web" } });
      const recording = { sessionId: input.sessionId, startedAt, bytes: new Blob([`${header}\n`]).size, lines: [header], truncated: false };
      this.recordings.set(input.sessionId, recording);
      return recording;
    },
    stop: async (sessionId: string) => {
      const recording = this.recordings.get(sessionId);
      if (!recording) throw new Error("Recording is not active");
      this.recordings.delete(sessionId);
      downloadBlob(new Blob([`${recording.lines.join("\n")}\n`], { type: "application/x-asciicast" }), `wan-ssh-${new Date(recording.startedAt).toISOString().replace(/[:.]/g, "-")}.cast`);
      return { saved: true, bytes: recording.bytes, truncated: recording.truncated };
    },
    discard: async (sessionId: string) => this.recordings.delete(sessionId)
  };

  readonly on = {
    termOutput: (listener: Listener) => this.listen("termOutput", listener),
    termExit: (listener: Listener) => this.listen("termExit", listener),
    sessionState: (listener: Listener) => this.listen("sessionState", listener),
    hostKeyPrompt: (listener: Listener) => this.listen("hostKeyPrompt", listener),
    authPrompt: (listener: Listener) => this.listen("authPrompt", listener),
    transferProgress: (listener: Listener) => this.listen("transferProgress", listener),
    tunnelChanged: (listener: Listener) => this.listen("tunnelChanged", listener),
    storeChanged: (listener: Listener) => this.listen("storeChanged", listener),
    vaultLocked: (listener: Listener) => this.listen("vaultLocked", listener),
    syncState: (listener: Listener) => this.listen("syncState", listener)
  };

  private async saveHost(input: any) {
    await this.readyUnlocked();
    const existing = input.id ? this.item(input.id) : null;
    const id = existing?.id ?? crypto.randomUUID();
    let identityId = input.identityId !== undefined ? input.identityId : existing?.identityId ?? null;
    if (input.username || input.password) {
      const previous = identityId ? this.item(identityId) : null;
      const inlineId = previous?.type === "identity" ? previous.id : crypto.randomUUID();
      const username = input.username || previous?.username || "root";
      const secret = input.password ? await this.vaultCore.encryptString(input.password, inlineId, "secret") : previous?.secret ?? null;
      const identity = this.entity(previous, inlineId, "identity", { label: `${username}@inline`, username, secret, keyId: previous?.keyId ?? null });
      await this.store.upsert(identity, previous?.version ?? 0);
      identityId = inlineId;
    }
    const host = this.entity(existing, id, "host", {
      groupId: input.groupId !== undefined ? input.groupId : existing?.groupId ?? null,
      label: input.label,
      address: input.address,
      port: input.port !== undefined ? input.port : existing?.port ?? null,
      protocol: "ssh",
      identityId,
      keyId: input.keyId !== undefined ? input.keyId : existing?.keyId ?? null,
      jumpHostId: input.jumpHostId !== undefined ? input.jumpHostId : existing?.jumpHostId ?? null,
      startupSnippetId: input.startupSnippetId !== undefined ? input.startupSnippetId : existing?.startupSnippetId ?? null,
      useLocalAgent: input.useLocalAgent ?? existing?.useLocalAgent ?? false,
      tags: input.tags ?? existing?.tags ?? [],
      environment: input.environment ?? existing?.environment ?? "none",
      favorite: input.favorite ?? existing?.favorite ?? false,
      agentForwarding: false,
      autoReconnect: input.autoReconnect ?? existing?.autoReconnect ?? true,
      reconnectLimit: input.reconnectLimit ?? existing?.reconnectLimit ?? 3,
      keepAliveInterval: input.keepAliveInterval ?? existing?.keepAliveInterval ?? 30,
      lastConnectedAt: existing?.lastConnectedAt ?? null
    });
    resolveJumpChain(host, (hostId) => hostId === id ? host : this.item(hostId));
    await this.store.upsert(host, existing?.version ?? 0);
    await this.auditRecord("host:save", { hostId: id });
    return id;
  }

  private hostView(host: Item) {
    const effective = resolveEffective(host, (id) => this.item(id));
    const identity = effective.identityId ? this.item(effective.identityId) : null;
    return {
      id: host.id,
      vaultId: PERSONAL,
      groupId: host.groupId ?? null,
      label: host.label,
      address: host.address,
      port: host.port ?? null,
      protocol: "ssh",
      identityId: host.identityId ?? null,
      keyId: host.keyId ?? null,
      jumpHostId: host.jumpHostId ?? null,
      startupSnippetId: host.startupSnippetId ?? null,
      useLocalAgent: Boolean(host.useLocalAgent),
      tags: host.tags ?? [],
      environment: host.environment ?? "none",
      favorite: Boolean(host.favorite),
      agentForwarding: false,
      autoReconnect: host.autoReconnect !== false,
      reconnectLimit: host.reconnectLimit ?? 3,
      keepAliveInterval: host.keepAliveInterval ?? 30,
      lastConnectedAt: host.lastConnectedAt ?? null,
      effectiveUsername: effective.username,
      effectivePort: effective.port,
      hasCredential: Boolean(identity?.secret || effective.keyId),
      groupPath: effective.groupPath
    };
  }

  private async openHostSession(hostId: string, cols: number, rows: number, startup: boolean) {
    await this.readyUnlocked();
    const host = this.requireItem(hostId, "host");
    const effective = resolveEffective(host, (id) => this.item(id));
    const target = { host: host.address, port: effective.port ?? 22, username: effective.username || "root" };
    const route = await Promise.all(resolveJumpChain(host, (id) => this.item(id)).map(async (jump) => {
      const jumpEffective = resolveEffective(jump, (id) => this.item(id));
      return {
        target: { host: jump.address, port: jumpEffective.port ?? 22, username: jumpEffective.username || "root" },
        authentication: await this.authenticationFor(jump),
        expectedHostKeyFingerprint: (await getKnownHost(jump.address, jumpEffective.port ?? 22).catch(() => undefined))?.fingerprint
      };
    }));
    const startupSnippet = startup && host.startupSnippetId ? this.item(host.startupSnippetId) : null;
    const input: WebSessionOpenInput = {
      target,
      terminal: { cols, rows, term: "xterm-256color" },
      authentication: await this.authenticationFor(host),
      expectedHostKeyFingerprint: (await getKnownHost(host.address, effective.port ?? 22).catch(() => undefined))?.fingerprint,
      ...(route.length ? { route: { jumps: route } } : {}),
      ...(Object.keys(effective.environment).length ? { environment: effective.environment } : {}),
      ...(startupSnippet?.command ? { startupCommand: startupSnippet.command } : {}),
      ...(host.useLocalAgent ? { egress: { mode: "client-agent" as const } } : {}),
      keepAliveInterval: host.keepAliveInterval ?? 30
    };
    const opened = await this.transport.open(input);
    this.sessions.set(opened.sessionId, { hostId, cols, rows });
    this.touch();
    return { sessionId: opened.sessionId, state: "connecting" };
  }

  private async authenticationFor(host: Item): Promise<WebSessionOpenInput["authentication"]> {
    const effective = resolveEffective(host, (id) => this.item(id));
    if (effective.keyId) {
      const key = this.requireItem(effective.keyId, "sshkey");
      return {
        method: "privateKey",
        privateKey: await this.vaultCore.decryptString(key.privateKey as VaultEnvelope, key.id),
        ...(key.passphrase ? { passphrase: await this.vaultCore.decryptString(key.passphrase as VaultEnvelope, key.id) } : {})
      };
    }
    const identity = effective.identityId ? this.item(effective.identityId) : null;
    if (identity?.secret) return { method: "password", password: await this.vaultCore.decryptString(identity.secret as VaultEnvelope, identity.id) };
    throw new Error(`No SSH credential is configured for ${host.label}`);
  }

  private async closeSession(sessionId: string) {
    await this.transport.close(sessionId).catch(() => undefined);
    this.sessions.delete(sessionId);
    this.sessionStates.delete(sessionId);
    for (const [id, tunnel] of this.activeTunnels) if (tunnel.sessionId === sessionId) this.activeTunnels.delete(id);
  }

  private async testConnection(hostId: string) {
    const started = Date.now();
    let sessionId: string | undefined;
    try {
      sessionId = (await this.openHostSession(hostId, 80, 24, false)).sessionId;
      await this.waitConnected(sessionId);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (sessionId) await this.closeSession(sessionId);
    }
  }

  private waitConnected(sessionId: string) {
    const current = this.sessionStates.get(sessionId);
    if (current?.state === "connected") return Promise.resolve();
    if (current?.error) return Promise.reject(current.error);
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("SSH connection timed out")), 75_000);
      const waiters = this.connectionWaiters.get(sessionId) ?? [];
      waiters.push({ resolve, reject, timeout });
      this.connectionWaiters.set(sessionId, waiters);
    });
  }

  private handleTransportEvent(event: SshTransportEvent) {
    if (event.type === "session.output") {
      this.captureRecording(event.sessionId, event.data);
      this.emit("termOutput", { sessionId: event.sessionId, data: event.data });
      return;
    }
    if (event.type === "session.exit") {
      this.emit("termExit", event);
      const error = new Error(event.message || event.reason);
      this.sessionStates.set(event.sessionId, { state: "disconnected", error });
      this.rejectConnection(event.sessionId, error);
      return;
    }
    if (event.type === "session.state") {
      const failed = event.state === "error" || event.state === "closed" || event.state === "disconnected";
      const error = failed ? new Error(event.message || event.reason || "SSH connection failed") : undefined;
      this.sessionStates.set(event.sessionId, { state: event.state, ...(error ? { error } : {}) });
      this.emit("sessionState", event);
      if (event.state === "connected") {
        this.resolveConnection(event.sessionId);
        const session = this.sessions.get(event.sessionId);
        if (session) void this.markConnected(session.hostId);
      } else if (error) {
        this.rejectConnection(event.sessionId, error);
      }
      return;
    }
    if (event.type === "hostkey.prompt") {
      this.promptHosts.set(event.sessionId, event);
      this.emit("hostKeyPrompt", { sessionId: event.sessionId, kind: event.kind, pattern: `${event.host}:${event.port}`, fingerprint: event.fingerprint, previous: event.previousFingerprint });
      return;
    }
    if (event.type === "auth.prompt") {
      this.emit("authPrompt", { sessionId: event.sessionId, prompts: event.prompts.map((prompt) => prompt.prompt) });
      return;
    }
    if (event.type === "tunnel.changed") {
      this.replaceSessionTunnels(event.sessionId, event.tunnels as Tunnel[]);
    }
  }

  private async markConnected(hostId: string) {
    const host = this.item(hostId);
    if (!host) return;
    const now = Date.now();
    await this.store.upsert({ ...host, lastConnectedAt: now, updatedAt: now, version: host.version + 1 }, host.version).catch(() => undefined);
  }

  private resolveConnection(sessionId: string) {
    const waiters = this.connectionWaiters.get(sessionId) ?? [];
    this.connectionWaiters.delete(sessionId);
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectConnection(sessionId: string, error: Error) {
    const waiters = this.connectionWaiters.get(sessionId) ?? [];
    this.connectionWaiters.delete(sessionId);
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  private async persistKey(label: string, input: any, passphrase: string | undefined, source: string) {
    const id = crypto.randomUUID();
    const key = this.entity(null, id, "sshkey", {
      label,
      algorithm: input.algorithm,
      bits: input.bits ?? null,
      publicKey: input.publicKey,
      privateKey: await this.vaultCore.encryptString(input.privateKey, id, "privateKey"),
      passphrase: passphrase ? await this.vaultCore.encryptString(passphrase, id, "passphrase") : null,
      fingerprintSha256: input.fingerprintSha256,
      source
    });
    await this.store.upsert(key, 0);
    await this.auditRecord("key:save", { keyId: id, source });
    return id;
  }

  private pickFiles() {
    return new Promise<File[]>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => resolve(Array.from(input.files ?? []));
      input.click();
    });
  }

  private enqueueUploads(sessionId: string, directory: string, files: File[], resume: boolean) {
    const jobs = files.map((file) => {
      const id = crypto.randomUUID();
      const job: TransferRecord = { id, sessionId, direction: "upload", source: file.name, destination: remoteJoin(directory, file.name), state: "queued", transferred: 0, total: file.size, file, remotePath: remoteJoin(directory, file.name) };
      this.transferJobs.set(id, job);
      this.publishTransfer(job);
      void this.runUpload(job, resume);
      return { transferId: id };
    });
    return jobs;
  }

  private async runUpload(job: TransferRecord, resume: boolean) {
    if (!job.file || !job.remotePath) return;
    try {
      job.state = "running";
      this.publishTransfer(job);
      let offset = 0;
      if (resume) {
        const existing = await this.transport.sftpStat(job.sessionId, job.remotePath).catch(() => undefined) as any;
        if (existing?.size === job.file.size) offset = job.file.size;
        else if (existing?.size > 0 && existing.size < job.file.size) offset = existing.size;
      }
      job.transferred = offset;
      if (job.file.size === 0) await this.transport.sftpWrite(job.sessionId, job.remotePath, 0, new Uint8Array(), true);
      while (offset < job.file.size) {
        if (job.canceled) return;
        const data = new Uint8Array(await job.file.slice(offset, offset + TRANSFER_CHUNK_BYTES).arrayBuffer());
        await this.transport.sftpWrite(job.sessionId, job.remotePath, offset, data, offset === 0);
        offset += data.byteLength;
        job.transferred = offset;
        this.publishTransfer(job);
      }
      job.state = "completed";
    } catch (error) {
      job.state = job.canceled ? "canceled" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
    this.publishTransfer(job);
  }

  private enqueueDownload(sessionId: string, remotePath: string) {
    const id = crypto.randomUUID();
    const name = remotePath.split("/").filter(Boolean).at(-1) || "download";
    const job: TransferRecord = { id, sessionId, direction: "download", source: remotePath, destination: name, state: "queued", transferred: 0, total: 0, remotePath };
    this.transferJobs.set(id, job);
    this.publishTransfer(job);
    void this.runDownload(job);
    return { transferId: id };
  }

  private async runDownload(job: TransferRecord) {
    if (!job.remotePath) return;
    try {
      job.state = "running";
      const metadata = await this.transport.sftpStat(job.sessionId, job.remotePath) as any;
      job.total = metadata.size ?? 0;
      this.publishTransfer(job);
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (offset < job.total) {
        if (job.canceled) return;
        const result = await this.transport.sftpRead(job.sessionId, job.remotePath, offset, Math.min(TRANSFER_CHUNK_BYTES, job.total - offset));
        chunks.push(result.data);
        offset += result.bytesRead;
        job.transferred = offset;
        this.publishTransfer(job);
        if (result.eof || result.bytesRead === 0) break;
      }
      downloadBlob(new Blob(chunks as BlobPart[]), job.destination);
      job.state = "completed";
    } catch (error) {
      job.state = job.canceled ? "canceled" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }
    this.publishTransfer(job);
  }

  private retryTransfer(id: string) {
    const job = this.transferJobs.get(id);
    if (!job || !["failed", "canceled"].includes(job.state)) return false;
    job.canceled = false;
    job.error = undefined;
    job.transferred = 0;
    job.state = "queued";
    this.publishTransfer(job);
    if (job.direction === "upload") void this.runUpload(job, true);
    else void this.runDownload(job);
    return true;
  }

  private publishTransfer(job: TransferRecord) {
    const { file: _file, remotePath: _remotePath, canceled: _canceled, ...view } = job;
    this.emit("transferProgress", view);
  }

  private replaceSessionTunnels(sessionId: string, tunnels: Tunnel[]) {
    for (const [id, tunnel] of this.activeTunnels) if (tunnel.sessionId === sessionId) this.activeTunnels.delete(id);
    for (const tunnel of tunnels) this.activeTunnels.set(tunnel.id, tunnel);
    this.emit("tunnelChanged", [...this.activeTunnels.values()]);
  }

  private captureRecording(sessionId: string, data: string) {
    const recording = this.recordings.get(sessionId);
    if (!recording || recording.truncated) return;
    const elapsed = Math.max(0, (Date.now() - recording.startedAt) / 1_000);
    const line = JSON.stringify([Number(elapsed.toFixed(6)), "o", data.replace(SECRET_PATTERN, "$1[REDACTED]")]);
    const bytes = new Blob([`${line}\n`]).size;
    if (recording.bytes + bytes > MAX_RECORDING_BYTES) {
      const marker = JSON.stringify([Number(elapsed.toFixed(6)), "o", "\r\n[recording truncated at 25 MiB]\r\n"]);
      recording.lines.push(marker);
      recording.bytes += new Blob([`${marker}\n`]).size;
      recording.truncated = true;
      return;
    }
    recording.lines.push(line);
    recording.bytes += bytes;
  }

  private async auditRecord(action: string, detail: Record<string, unknown>) {
    if (!this.vaultCore.unlocked) return;
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ action, outcome: "success", detail });
    const audit = this.entity(null, id, "audit", { envelope: await this.vaultCore.encryptString(payload, id, "audit"), timestamp: Date.now() });
    await this.store.upsert(audit, 0).catch(() => undefined);
  }

  private async auditList(limit: number) {
    await this.readyUnlocked();
    const values = this.store.list<Item>("audit").slice(0, Math.max(1, Math.min(limit, 500)));
    const result = [];
    for (const entry of values) {
      try {
        result.push({ id: entry.id, timestamp: entry.timestamp ?? entry.updatedAt, ...JSON.parse(await this.vaultCore.decryptString(entry.envelope, entry.id)) });
      } catch {
        result.push({ id: entry.id, timestamp: entry.timestamp ?? entry.updatedAt, action: "unreadable", outcome: "failure", detail: {} });
      }
    }
    return result;
  }

  private entity(existing: Item | null, id: string, type: string, fields: Record<string, unknown>): Item {
    const now = Date.now();
    return { id, type, ownerUid: this.store.uid, vaultId: PERSONAL, updatedAt: now, version: (existing?.version ?? 0) + 1, deletedAt: null, ...fields };
  }

  private item(id: string): Item | null {
    return this.store.get<Item>(id);
  }

  private requireItem(id: string, type: string): Item {
    const item = this.item(id);
    if (!item || item.type !== type) throw new Error(`${type} was not found`);
    return item;
  }

  private requireMeta(): CloudVaultMeta {
    const meta = this.store.meta();
    if (!meta) throw new Error("Cloud vault has not been created");
    return meta;
  }

  private async readyUnlocked() {
    await this.store.ready();
    if (!this.vaultCore.unlocked) throw new Error("Cloud vault is locked");
    this.touch();
  }

  private async lock() {
    window.clearTimeout(this.autoLockTimer);
    await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.transport.close(sessionId)));
    this.sessions.clear();
    this.recordings.clear();
    this.activeTunnels.clear();
    this.vaultCore.lock();
    this.transport.disconnect("Cloud vault locked");
    this.emit("vaultLocked");
  }

  private touch() {
    if (!this.vaultCore.unlocked) return;
    window.clearTimeout(this.autoLockTimer);
    this.autoLockTimer = window.setTimeout(() => void this.lock(), this.autoLockMs);
  }

  private listen(name: EventName, listener: Listener) {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  private emit(name: EventName, payload?: any) {
    for (const listener of this.listeners.get(name) ?? []) listener(payload);
  }
}