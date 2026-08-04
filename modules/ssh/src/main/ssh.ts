import * as node_crypto from "node:crypto";
import * as ssh2 from "ssh2";
import { APP, SSH } from "./constants.js";
import { SshError, VaultError, mapSshError } from "./errors.js";
import { wipe } from "./crypto.js";
import { itemRepo, resolveEffective } from "./repo.js";
import { fingerprintOf, knownHostPattern, knownHosts } from "./knownhosts.js";
import type { VaultCore } from "./vault.js";

type EmitFn = (channel: string, payload: any) => void;
type SessionEndFn = (sessionId: string, reason: string) => void;

export class SshSession {
  host: any;
  creds: any;
  ownerUid: string;
  emit: EmitFn;
  id = node_crypto.randomUUID();
  client = new ssh2.Client();
  stream: any;
  outBuf: string[] = [];
  flushTimer: any;
  pendingAuthFinish: any;
  pendingHostKey: any;
  pendingHostKeyDetails: { pattern: string; key: Buffer; changed: boolean } | null = null;
  onEnd: SessionEndFn;
  ended = false;
  status = "idle";
  reconnectAttempt = 0;
  auxiliaryClients: ssh2.Client[] = [];
  cols = 80;
  rows = 24;

  constructor(host: any, creds: any, ownerUid: string, emit: EmitFn, onEnd: SessionEndFn) {
    this.host = host;
    this.creds = creds;
    this.ownerUid = ownerUid;
    this.emit = emit;
    this.onEnd = onEnd;
  }

  connectionConfig(host: any, creds: any, sock?: any) {
    const agent = process.platform === "win32" ? "pageant" : process.env.SSH_AUTH_SOCK;
    const cfg: any = {
      host: host.address,
      port: creds.port ?? host.port ?? SSH.defaultPort,
      username: creds.username,
      ident: APP.sshIdent,
      readyTimeout: SSH.readyTimeoutMs,
      keepaliveInterval: (host.keepAliveInterval ?? SSH.keepAliveIntervalSec) * 1e3,
      keepaliveCountMax: SSH.keepAliveCountMax,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        void this.verifyHostKeyFor(host, key).then(verify);
      }
    };
    if (host.agentForwarding) {
      if (!agent) throw new SshError("UNKNOWN", "SSH agent forwarding aktif, tetapi SSH_AUTH_SOCK tidak tersedia.");
      cfg.agent = agent;
      cfg.agentForward = true;
    }
    if (sock) cfg.sock = sock;
    if (creds.privateKey) {
      cfg.privateKey = creds.privateKey;
      if (creds.passphrase) cfg.passphrase = creds.passphrase;
    } else if (creds.password) {
      cfg.password = creds.password;
    }
    return cfg;
  }

  bindInteractiveAuth(client: ssh2.Client) {
    client.on("keyboard-interactive", (_n: any, _i: any, _l: any, prompts: any[], finish: any) => {
      this.pendingAuthFinish = finish;
      this.emit("session:state", { sessionId: this.id, state: "authenticating" });
      this.emit("auth:prompt", { sessionId: this.id, prompts: prompts.map((p) => p.prompt) });
    });
  }

  async awaitReady(client: ssh2.Client, cfg: any) {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        client.off("ready", onReady);
        reject(error);
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(cfg);
    });
  }

  async connect(cols: number, rows: number, sock?: any) {
    this.cols = cols;
    this.rows = rows;
    this.client = new ssh2.Client();
    this.stream = void 0;
    this.ended = false;
    this.status = "connecting";
    this.emit("session:state", { sessionId: this.id, state: "connecting" });
    const cfg = this.connectionConfig(this.host, this.creds, sock);
    this.bindInteractiveAuth(this.client);
    await this.awaitReady(this.client, cfg);
    this.client.on("error", (error: Error) => {
      const mapped = mapSshError(error);
      this.finish(1, mapped.kind, mapped.message);
    });
    this.client.on("close", () => this.finish(0, "transport-closed"));
    wipe(this.creds.privateKey);
    this.creds.password = void 0;
    this.creds.passphrase = void 0;
    this.stream = await this.openShell(cols, rows);
    this.status = "connected";
    this.reconnectAttempt = 0;
    this.emit("session:state", { sessionId: this.id, state: "connected" });
  }
  openShell(cols: number, rows: number) {
    return new Promise<any>((resolve, reject) => {
      this.client.shell({ term: APP.term, cols, rows }, { env: this.creds.envVars ?? {} }, (err: any, stream: any) => {
        if (err) return reject(err);
        stream.on("data", (d: Buffer) => this.push(d.toString("utf8")));
        stream.stderr.on("data", (d: Buffer) => this.push(d.toString("utf8")));
        stream.on("close", (code: number) => {
          this.finish(code ?? 0, "remote-closed");
        });
        resolve(stream);
      });
    });
  }
  async verifyHostKeyFor(host: any, key: Buffer) {
    const pattern = knownHostPattern(host.address, host.port ?? SSH.defaultPort);
    const fp = fingerprintOf(key);
    const known = knownHosts.find(pattern);
    if (!known) {
      const ok = await this.promptHostKey("unknown", pattern, fp, key);
      if (ok) knownHosts.add(pattern, "ssh", key, this.ownerUid, host.vaultId);
      return ok;
    }
    if (knownHosts.matches(known, key)) return true;
    const ok = await this.promptHostKey("changed", pattern, fp, key, fingerprintOf(Buffer.from(known.publicKey, "base64")));
    if (ok) knownHosts.add(pattern, "ssh", key, this.ownerUid, known.vaultId);
    return ok;
  }
  promptHostKey(kind: string, pattern: string, fingerprint: string, key: Buffer, previous?: string) {
    return new Promise<boolean>((resolve) => {
      this.pendingHostKey = resolve;
      this.pendingHostKeyDetails = { pattern, key: Buffer.from(key), changed: kind === "changed" };
      this.emit("host:keyPrompt", { sessionId: this.id, kind, pattern, fingerprint, previous });
    });
  }
  answerHostKey(accept: boolean) {
    this.pendingHostKey?.(accept);
    this.pendingHostKey = void 0;
    this.pendingHostKeyDetails = null;
  }
  answerAuthPrompt(answers: string[]) {
    this.pendingAuthFinish?.(answers);
    this.pendingAuthFinish = void 0;
  }
  /** Batching output — pembeda terminal mulus vs patah-patah (Bab 10.1). */
  push(chunk: string) {
    if (this.ended) return;
    this.outBuf.push(chunk);
    if (this.outBuf.length > SSH.flushChunkThreshold) return this.flush();
    this.flushTimer ??= setTimeout(() => this.flush(), SSH.flushIntervalMs);
  }
  flush() {
    if (!this.outBuf.length) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = void 0;
    const data2 = this.outBuf.join("");
    this.outBuf.length = 0;
    this.emit("term:output", { sessionId: this.id, data: data2 });
  }
  write(data2: string) {
    this.stream?.write(data2);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.stream?.setWindow(rows, cols, 0, 0);
  }
  endTransport() {
    try {
      this.stream?.end();
      this.client.end();
      for (const client of this.auxiliaryClients) client.end();
    } catch {
    }
    this.auxiliaryClients.length = 0;
  }
  finish(code: number, reason: string, message?: string) {
    if (this.ended) return;
    this.ended = true;
    this.status = reason === "user-closed" || reason === "vault-locked" ? "closed" : "disconnected";
    this.flush();
    this.pendingHostKey?.(false);
    this.pendingHostKey = void 0;
    this.pendingHostKeyDetails = null;
    this.pendingAuthFinish?.([]);
    this.pendingAuthFinish = void 0;
    wipe(this.creds?.privateKey);
    if (this.creds) {
      this.creds.password = void 0;
      this.creds.passphrase = void 0;
    }
    this.emit("session:state", { sessionId: this.id, state: this.status, reason, message });
    this.emit("term:exit", { sessionId: this.id, code, reason, message });
    this.onEnd(this.id, reason);
    this.endTransport();
  }
  close() {
    this.finish(0, "user-closed");
  }
}

export class SshManager {
  vault: VaultCore;
  ownerUid: () => string;
  emit: EmitFn;
  sessions = new Map<string, SshSession>();
  reconnectTimers = new Map<string, NodeJS.Timeout>();
  sessionEndListeners = new Set<(sessionId: string) => void>();

  constructor(vault: VaultCore, ownerUid: () => string, emit: EmitFn) {
    this.vault = vault;
    this.ownerUid = ownerUid;
    this.emit = emit;
  }
  /** Resolve credential efektif via warisan host → identity → group chain (Bab 2.2, M3). */
  resolveCredentials(host: any) {
    const eff = resolveEffective(host, (id) => itemRepo.get(id));
    let password: string | undefined;
    let privateKey: Buffer | undefined;
    let passphrase: string | undefined;
    const username = eff.username || "root";
    const identity = eff.identityId ? itemRepo.get(eff.identityId) : null;
    try {
      if (identity?.secret) password = this.vault.decryptString(identity.secret, identity.id);
      if (eff.keyId) {
        const key = itemRepo.get(eff.keyId);
        if (key) {
          privateKey = this.vault.decryptField(key.privateKey, key.id);
          if (key.passphrase) passphrase = this.vault.decryptString(key.passphrase, key.id);
        }
      }
    } catch (e) {
      // Kredensial disegel dengan Vault Key lain (belum tersinkron ke perangkat
      // ini) — sampaikan sebagai gagal-auth yang jelas, bukan crash crypto.
      if (e instanceof VaultError && e.code === "UNDECRYPTABLE") {
        throw new SshError(
          "AUTH_FAILED",
          "Kredensial host ini tersimpan dengan Vault Key lain (belum tersinkron ke perangkat ini). Buka kunci dengan master password asli, atau simpan ulang kredensialnya."
        );
      }
      throw e;
    }
    return {
      username,
      password,
      privateKey,
      passphrase,
      port: eff.port ?? SSH.defaultPort,
      envVars: eff.envVars
    };
  }
  async open(hostId: string, cols: number, rows: number, runStartupSnippet = true) {
    const host = itemRepo.get(hostId);
    if (!host) throw new SshError("UNKNOWN", "Host tidak ditemukan");
    const creds = this.resolveCredentials(host);
    const effectiveHost = { ...host, port: creds.port };
    const session = new SshSession(effectiveHost, creds, this.ownerUid(), this.emit, (sessionId, reason) => {
      this.handleSessionEnd(sessionId, reason);
    });
    this.sessions.set(session.id, session);
    try {
      await this.connectSession(session, cols, rows, runStartupSnippet);
    } catch (err) {
      this.sessions.delete(session.id);
      session.endTransport();
      wipe(creds.privateKey);
      creds.password = void 0;
      creds.passphrase = void 0;
      const mapped = mapSshError(err);
      throw new SshError(mapped.kind, mapped.message);
    }
    if (runStartupSnippet) this.markConnected(host.id);
    return { sessionId: session.id };
  }
  async connectSession(session: SshSession, cols: number, rows: number, runStartupSnippet = true) {
    const jumpHostId = session.host.jumpHostId;
    if (!jumpHostId) {
      await session.connect(cols, rows);
      if (runStartupSnippet) this.runStartupSnippet(session);
      return;
    }
    if (jumpHostId === session.host.id) throw new SshError("UNKNOWN", "Jump host tidak boleh menunjuk ke host yang sama");
    const jumpHost = itemRepo.get(jumpHostId);
    if (!jumpHost || jumpHost.type !== "host") throw new SshError("UNKNOWN", "Jump host tidak ditemukan");
    if (jumpHost.jumpHostId) throw new SshError("UNKNOWN", "Jump host bertingkat belum didukung; pilih bastion tanpa jump host lain");
    const jumpCreds = this.resolveCredentials(jumpHost);
    const effectiveJumpHost = { ...jumpHost, port: jumpCreds.port };
    const jumpClient = new ssh2.Client();
    session.bindInteractiveAuth(jumpClient);
    try {
      await session.awaitReady(jumpClient, session.connectionConfig(effectiveJumpHost, jumpCreds));
      const socket = await new Promise<any>((resolve, reject) => {
        jumpClient.forwardOut(
          "127.0.0.1",
          0,
          session.host.address,
          session.host.port ?? SSH.defaultPort,
          (error: Error | undefined, stream: any) => error ? reject(error) : resolve(stream)
        );
      });
      session.auxiliaryClients.push(jumpClient);
      await session.connect(cols, rows, socket);
      if (runStartupSnippet) this.runStartupSnippet(session);
    } catch (error) {
      jumpClient.end();
      throw error;
    } finally {
      wipe(jumpCreds.privateKey);
      jumpCreds.password = void 0;
      jumpCreds.passphrase = void 0;
    }
  }
  runStartupSnippet(session: SshSession) {
    if (!session.host.startupSnippetId) return;
    const snippet = itemRepo.get(session.host.startupSnippetId);
    if (snippet?.type === "snippet" && snippet.command) session.write(`${snippet.command}\r`);
  }
  markConnected(hostId: string) {
    const host = itemRepo.get(hostId);
    if (!host || host.type !== "host") return;
    const now = Date.now();
    itemRepo.upsert({
      ...host,
      lastConnectedAt: now,
      updatedAt: now,
      version: (host.version ?? 0) + 1
    });
    this.emit("store:changed", void 0);
  }
  getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }
  onSessionEnd(listener: (sessionId: string) => void) {
    this.sessionEndListeners.add(listener);
    return () => this.sessionEndListeners.delete(listener);
  }
  handleSessionEnd(sessionId: string, reason: string) {
    for (const listener of this.sessionEndListeners) listener(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session || reason === "user-closed" || reason === "vault-locked") return;
    const limit = session.host.reconnectLimit ?? 3;
    if (!session.host.autoReconnect || session.reconnectAttempt >= limit) {
      // Reconnect exhausted or disabled — remove stale session from map.
      this.sessions.delete(sessionId);
      return;
    }
    const attempt = ++session.reconnectAttempt;
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
    this.emit("session:state", { sessionId, state: "reconnecting", attempt, delayMs });
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId);
      void this.reconnect(sessionId, session.cols, session.rows, true);
    }, delayMs);
    this.reconnectTimers.set(sessionId, timer);
  }
  async reconnect(sessionId: string, cols: number, rows: number, automatic = false) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SshError("UNKNOWN", "Sesi tidak ditemukan");
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(sessionId);
    const host = itemRepo.get(session.host.id);
    if (!host) throw new SshError("UNKNOWN", "Host tidak ditemukan");
    const creds = this.resolveCredentials(host);
    session.host = host;
    session.creds = creds;
    try {
      session.endTransport();
      await this.connectSession(session, cols, rows);
      this.markConnected(host.id);
      return { sessionId };
    } catch (error) {
      wipe(creds.privateKey);
      const mapped = mapSshError(error);
      this.emit("session:state", { sessionId, state: "error", reason: mapped.kind, message: mapped.message });
      if (automatic) this.handleSessionEnd(sessionId, mapped.kind);
      throw new SshError(mapped.kind, mapped.message);
    }
  }
  /** Test koneksi cepat: sukses connect lalu langsung tutup (Bab 15.4). */
  async testConnection(hostId: string) {
    const started = Date.now();
    try {
      const { sessionId } = await this.open(hostId, 80, 24, false);
      const latencyMs = Date.now() - started;
      this.close(sessionId);
      return { ok: true, latencyMs };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  write(sessionId: string, data2: string) {
    this.sessions.get(sessionId)?.write(data2);
  }
  resize(sessionId: string, cols: number, rows: number) {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }
  answerAuthPrompt(sessionId: string, answers: string[]) {
    this.sessions.get(sessionId)?.answerAuthPrompt(answers);
  }
  answerHostKey(sessionId: string, accept: boolean) {
    this.sessions.get(sessionId)?.answerHostKey(accept);
  }
  close(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const timer = this.reconnectTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(sessionId);
    this.sessions.delete(sessionId);
    s.close();
  }
  /** Push public key ke authorized_keys server, idempoten (Bab 10.4). */
  async pushKey(publicKey: string, hostId: string) {
    if (!publicKey || publicKey.startsWith("(")) throw new SshError("UNKNOWN", "Public key tidak tersedia");
    // Validate public key format: must be single-line, no control chars, match
    // standard "type base64 comment" pattern to prevent shell injection.
    const trimmed = publicKey.trim();
    if (/[\x00-\x1f\x7f`$\\]/.test(trimmed) || trimmed.includes("\n") || !/^(ssh-\w+|ecdsa-\S+) [A-Za-z0-9+/=]+ ?.*$/.test(trimmed)) {
      throw new SshError("UNKNOWN", "Format public key tidak valid atau mengandung karakter berbahaya");
    }
    const host = itemRepo.get(hostId);
    if (!host) throw new SshError("UNKNOWN", "Host tidak ditemukan");
    const creds = this.resolveCredentials(host);
    const client = new ssh2.Client();
    const cfg: any = {
      host: host.address,
      port: host.port ?? SSH.defaultPort,
      username: creds.username,
      ident: APP.sshIdent,
      readyTimeout: SSH.readyTimeoutMs,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const known = knownHosts.find(knownHostPattern(host.address, host.port ?? SSH.defaultPort));
        verify(!!known && knownHosts.matches(known, key));
      }
    };
    if (creds.privateKey) {
      cfg.privateKey = creds.privateKey;
      if (creds.passphrase) cfg.passphrase = creds.passphrase;
    } else if (creds.password) cfg.password = creds.password;
    const q = trimmed.replace(/'/g, `'\\''`);
    const cmd = [
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
      "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
      `grep -qxF '${q}' ~/.ssh/authorized_keys || echo '${q}' >> ~/.ssh/authorized_keys`
    ].join(" && ");
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("ready", () => {
          client.exec(cmd, (err: any, stream: any) => {
            if (err) return reject(err);
            stream.on("close", (code: number) => code === 0 ? resolve() : reject(new Error("exec gagal")));
            stream.resume();
          });
        });
        client.once("error", reject);
        client.connect(cfg);
      });
    } catch (e) {
      const m = mapSshError(e);
      throw new SshError(m.kind, m.kind === "HOST_KEY_REJECTED" || /verif/i.test(m.message) ? "Hubungkan ke host ini dulu agar kuncinya dipercaya, lalu ulangi push." : m.message);
    } finally {
      wipe(creds.privateKey);
      client.end();
    }
  }
  /** Tutup semua sesi — dipanggil saat vault di-lock (Bab 7.3). */
  closeAll(reason: string) {
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const s of sessions) {
      s.finish(0, reason);
    }
  }
}
