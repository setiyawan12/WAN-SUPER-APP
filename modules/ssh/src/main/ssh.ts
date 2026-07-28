import * as node_crypto from "node:crypto";
import * as ssh2 from "ssh2";
import { APP, SSH } from "./constants.js";
import { SshError, mapSshError } from "./errors.js";
import { wipe } from "./crypto.js";
import { itemRepo, resolveEffective } from "./repo.js";
import { fingerprintOf, knownHosts } from "./knownhosts.js";
import type { VaultCore } from "./vault.js";

type EmitFn = (channel: string, payload: any) => void;

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

  constructor(host: any, creds: any, ownerUid: string, emit: EmitFn) {
    this.host = host;
    this.creds = creds;
    this.ownerUid = ownerUid;
    this.emit = emit;
  }

  async connect(cols: number, rows: number) {
    const cfg: any = {
      host: this.host.address,
      port: this.host.port ?? SSH.defaultPort,
      username: this.creds.username,
      ident: APP.sshIdent,
      readyTimeout: SSH.readyTimeoutMs,
      keepaliveInterval: (this.host.keepAliveInterval || SSH.keepAliveIntervalSec) * 1e3,
      keepaliveCountMax: SSH.keepAliveCountMax,
      agentForward: this.host.agentForwarding,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        void this.verifyHostKey(key).then(verify);
      }
    };
    if (this.creds.privateKey) {
      cfg.privateKey = this.creds.privateKey;
      if (this.creds.passphrase) cfg.passphrase = this.creds.passphrase;
    } else if (this.creds.password) {
      cfg.password = this.creds.password;
    }
    this.client.on("keyboard-interactive", (_n: any, _i: any, _l: any, prompts: any[], finish: any) => {
      this.pendingAuthFinish = finish;
      this.emit("auth:prompt", { sessionId: this.id, prompts: prompts.map((p) => p.prompt) });
    });
    await new Promise<void>((resolve, reject) => {
      this.client.once("ready", () => resolve());
      this.client.once("error", reject);
      this.client.connect(cfg);
    });
    wipe(this.creds.privateKey);
    this.creds.password = void 0;
    this.creds.passphrase = void 0;
    this.stream = await this.openShell(cols, rows);
  }
  openShell(cols: number, rows: number) {
    return new Promise<any>((resolve, reject) => {
      this.client.shell({ term: APP.term, cols, rows }, (err: any, stream: any) => {
        if (err) return reject(err);
        stream.on("data", (d: Buffer) => this.push(d.toString("utf8")));
        stream.stderr.on("data", (d: Buffer) => this.push(d.toString("utf8")));
        stream.on("close", (code: number) => {
          this.flush();
          this.emit("term:exit", { sessionId: this.id, code: code ?? 0, reason: "closed" });
        });
        resolve(stream);
      });
    });
  }
  async verifyHostKey(key: Buffer) {
    const pattern = `${this.host.address}:${this.host.port ?? SSH.defaultPort}`;
    const fp = fingerprintOf(key);
    const known = knownHosts.find(pattern);
    if (!known) {
      const ok = await this.promptHostKey("unknown", pattern, fp);
      if (ok) knownHosts.add(pattern, "ssh", key, this.ownerUid);
      return ok;
    }
    if (knownHosts.matches(known, key)) return true;
    return this.promptHostKey("changed", pattern, fp, known.publicKey);
  }
  promptHostKey(kind: string, pattern: string, fingerprint: string, previous?: string) {
    return new Promise<boolean>((resolve) => {
      this.pendingHostKey = resolve;
      this.emit("host:keyPrompt", { sessionId: this.id, kind, pattern, fingerprint, previous });
    });
  }
  answerHostKey(accept: boolean) {
    this.pendingHostKey?.(accept);
    this.pendingHostKey = void 0;
  }
  answerAuthPrompt(answers: string[]) {
    this.pendingAuthFinish?.(answers);
    this.pendingAuthFinish = void 0;
  }
  /** Batching output — pembeda terminal mulus vs patah-patah (Bab 10.1). */
  push(chunk: string) {
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
    this.stream?.setWindow(rows, cols, 0, 0);
  }
  close() {
    try {
      this.stream?.end();
      this.client.end();
    } catch {
    }
  }
}

export class SshManager {
  vault: VaultCore;
  ownerUid: () => string;
  emit: EmitFn;
  sessions = new Map<string, SshSession>();

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
    if (identity?.secret) password = this.vault.decryptString(identity.secret, identity.id);
    if (eff.keyId) {
      const key = itemRepo.get(eff.keyId);
      if (key) {
        privateKey = this.vault.decryptField(key.privateKey, key.id);
        if (key.passphrase) passphrase = this.vault.decryptString(key.passphrase, key.id);
      }
    }
    return { username, password, privateKey, passphrase };
  }
  async open(hostId: string, cols: number, rows: number) {
    const host = itemRepo.get(hostId);
    if (!host) throw new SshError("UNKNOWN", "Host tidak ditemukan");
    const creds = this.resolveCredentials(host);
    const session = new SshSession(host, creds, this.ownerUid(), this.emit);
    this.sessions.set(session.id, session);
    try {
      await session.connect(cols, rows);
    } catch (err) {
      this.sessions.delete(session.id);
      wipe(creds.privateKey);
      const mapped = mapSshError(err);
      throw new SshError(mapped.kind, mapped.message);
    }
    return { sessionId: session.id };
  }
  /** Test koneksi cepat: sukses connect lalu langsung tutup (Bab 15.4). */
  async testConnection(hostId: string) {
    const started = Date.now();
    try {
      const { sessionId } = await this.open(hostId, 80, 24);
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
    s.close();
    this.sessions.delete(sessionId);
  }
  /** Push public key ke authorized_keys server, idempoten (Bab 10.4). */
  async pushKey(publicKey: string, hostId: string) {
    if (!publicKey || publicKey.startsWith("(")) throw new SshError("UNKNOWN", "Public key tidak tersedia");
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
        const known = knownHosts.find(`${host.address}:${host.port ?? SSH.defaultPort}`);
        verify(!!known && knownHosts.matches(known, key));
      }
    };
    if (creds.privateKey) {
      cfg.privateKey = creds.privateKey;
      if (creds.passphrase) cfg.passphrase = creds.passphrase;
    } else if (creds.password) cfg.password = creds.password;
    const q = publicKey.trim().replace(/'/g, `'\\''`);
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
    for (const [id, s] of this.sessions) {
      s.close();
      this.emit("term:exit", { sessionId: id, code: 0, reason });
    }
    this.sessions.clear();
  }
}
