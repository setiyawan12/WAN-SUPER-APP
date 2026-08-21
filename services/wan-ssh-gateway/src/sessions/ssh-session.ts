import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { posix as posixPath } from "node:path";
import type { Duplex } from "node:stream";
import { Client, type ClientChannel, type ConnectConfig, type Prompt, type SFTPWrapper } from "ssh2";
import type { AgentBridgeConnector } from "../agent/hub.js";
import type { GatewayConfig } from "../config.js";
import { GatewayError, normalizeError, type ErrorCode } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { hashLogValue } from "../observability/logger.js";
import { targetDeniedReason, type GatewayMetrics } from "../observability/metrics.js";
import type { ServerMessage, SessionOpenMessage } from "../protocol.js";
import type { ConnectionContext } from "./types.js";
import { fingerprintHostKey, hostKeyAlgorithm } from "./host-key.js";
import { normalizeKnownHost, type KnownHostStore } from "./known-host-store.js";
import { connectResolvedTarget, resolveForwardTarget, resolveTarget, sshConnectEndpoint, type ResolvedTarget } from "./target-policy.js";

export type SessionState = "created" | "connecting" | "authenticating" | "connected" | "closing" | "closed";

export interface ManagedSession {
  readonly id: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly state: SessionState;
  start(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  answerHostKey(accept: boolean): void;
  answerAuthPrompt(answers: string[]): void;
  sftpHome?(): Promise<string>;
  sftpList?(path: string): Promise<Array<{ name: string; path: string; type: "directory" | "file" | "symlink"; size: number; mode: number; modifiedAt: number }>>;
  sftpStat?(path: string): Promise<{ name: string; path: string; type: "directory" | "file" | "symlink"; size: number; mode: number; modifiedAt: number }>;
  sftpMkdir?(path: string): Promise<void>;
  sftpRename?(from: string, to: string): Promise<void>;
  sftpRemove?(path: string, directory: boolean): Promise<void>;
  sftpWrite?(path: string, offset: number, data: Buffer, truncate: boolean): Promise<number>;
  sftpRead?(path: string, offset: number, length: number): Promise<{ data: Buffer; bytesRead: number; size: number; eof: boolean }>;
  startRemoteTunnel?(input: { bindAddress: string; bindPort: number; targetHost: string; targetPort: number; label?: string }): Promise<RemoteTunnelView>;
  listTunnels?(): RemoteTunnelView[];
  stopTunnel?(tunnelId: string): Promise<boolean>;
  installPublicKey?(publicKey: string): Promise<void>;
  close(reason?: string): void;
}

export type RemoteTunnelView = {
  id: string;
  sessionId: string;
  kind: "remote";
  label: string;
  bindAddress: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  state: "active" | "stopping" | "error";
  error?: string;
};

type RemoteTunnelRecord = RemoteTunnelView & { resolvedTarget: ResolvedTarget };

function callbackPromise<T>(invoke: (done: (error?: Error | null, value?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => invoke((error, value) => error ? reject(error) : resolve(value as T)));
}

function remoteFileType(mode = 0): "directory" | "file" | "symlink" {
  const kind = mode & 0o170000;
  if (kind === 0o040000) return "directory";
  if (kind === 0o120000) return "symlink";
  return "file";
}

function remotePath(value: string) {
  if (!value || value.includes("\0")) throw new GatewayError("SFTP_FAILED", "Remote path is invalid");
  return value;
}

function removableRemotePath(value: string) {
  const normalized = posixPath.normalize(remotePath(value));
  if (normalized === "/" || normalized === "." || normalized === "..") throw new GatewayError("SFTP_FAILED", "Remote root cannot be removed");
  return normalized;
}

async function removeRemoteTree(sftp: SFTPWrapper, path: string, depth = 0): Promise<void> {
  if (depth > 128) throw new GatewayError("SFTP_FAILED", "Remote directory depth limit exceeded");
  const rows = await callbackPromise<any[]>((done) => sftp.readdir(path, done));
  for (const row of rows) {
    if (row.filename === "." || row.filename === "..") continue;
    const child = posixPath.join(path, row.filename);
    if (remoteFileType(row.attrs?.mode) === "directory") await removeRemoteTree(sftp, child, depth + 1);
    else await callbackPromise<void>((done) => sftp.unlink(child, done));
  }
  await callbackPromise<void>((done) => sftp.rmdir(path, done));
}

type SessionOptions = {
  config: GatewayConfig;
  context: ConnectionContext;
  input: SessionOpenMessage;
  metrics?: GatewayMetrics;
  knownHosts?: KnownHostStore;
  agentBridge?: AgentBridgeConnector;
  logger: Logger;
  onClose(session: SshSession): void;
};

type SessionCredential = {
  privateKey?: Buffer;
  passphrase?: Buffer;
  password?: string;
};

type RouteHop = SessionCredential & {
  target: SessionOpenMessage["target"];
  expectedFingerprint?: string;
};

export function sshReadyTimeoutMs(config: GatewayConfig) {
  return config.connectTimeoutMs + config.hostKeyTimeoutMs;
}

function mapSshError(error: unknown, hostKeyRejected: boolean) {
  if (error instanceof GatewayError) return error;
  if (hostKeyRejected) return new GatewayError("SSH_HOST_KEY_REJECTED", "SSH host key was rejected");
  const message = error instanceof Error ? error.message : "";
  const level = error && typeof error === "object" && "level" in error ? String((error as { level?: unknown }).level) : "";
  if (/timed? ?out/i.test(message) || level === "client-timeout") return new GatewayError("SSH_TIMEOUT", "SSH connection timed out", true);
  if (/authentication|all configured authentication methods failed/i.test(message) || level === "client-authentication") {
    return new GatewayError("SSH_AUTH_FAILED", "SSH authentication failed");
  }
  return new GatewayError("SSH_CONNECTION_FAILED", "SSH connection failed", true);
}

function consumeAuthentication(authentication: SessionOpenMessage["authentication"]): SessionCredential {
  if (authentication.method === "privateKey") {
    const privateKey = Buffer.from(authentication.privateKey, "utf8");
    const passphrase = authentication.passphrase ? Buffer.from(authentication.passphrase, "utf8") : undefined;
    authentication.privateKey = "";
    authentication.passphrase = undefined;
    return { privateKey, passphrase };
  }
  const password = authentication.password;
  authentication.password = "";
  return { password };
}

export class SshSession implements ManagedSession {
  readonly id = randomUUID();
  readonly connectionId: string;
  readonly principalId: string;
  state: SessionState = "created";
  private readonly config: GatewayConfig;
  private readonly context: ConnectionContext;
  private readonly logger: Logger;
  private readonly metrics?: GatewayMetrics;
  private readonly knownHosts?: KnownHostStore;
  private readonly agentBridge?: AgentBridgeConnector;
  private readonly onClose: (session: SshSession) => void;
  private readonly startedAt = Date.now();
  private connectStartedAt = 0;
  private readonly target: SessionOpenMessage["target"];
  private readonly terminal: SessionOpenMessage["terminal"];
  private readonly expectedFingerprint?: string;
  private readonly route: RouteHop[];
  private readonly environment: Record<string, string>;
  private readonly startupCommand?: string;
  private readonly keepAliveIntervalMs: number;
  private readonly egressMode?: "client-agent";
  private client?: Client;
  private socket?: Socket | ClientChannel | Duplex;
  private stream?: ClientChannel;
  private readonly auxiliaryClients: Client[] = [];
  private readonly routeSockets: Array<Socket | ClientChannel | Duplex> = [];
  private readonly remoteTunnels = new Map<string, RemoteTunnelRecord>();
  private remoteTunnelHandler?: (...args: any[]) => void;
  private privateKey?: Buffer;
  private passphrase?: Buffer;
  private password?: string;
  private outputChunks: string[] = [];
  private outputBytes = 0;
  private flushTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private maxAgeTimer?: NodeJS.Timeout;
  private hostKeyTimer?: NodeJS.Timeout;
  private backpressureTimer?: NodeJS.Timeout;
  private backpressurePoll?: NodeJS.Timeout;
  private pendingHostKey?: (accept: boolean) => void;
  private pendingAuth?: (answers: string[]) => void;
  private hostKeyRejected = false;
  private closed = false;
  private errorSent = false;
  private exitSent = false;

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.context = options.context;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.knownHosts = options.knownHosts;
    this.agentBridge = options.agentBridge;
    this.onClose = options.onClose;
    this.connectionId = options.context.id;
    this.principalId = options.context.principal.id;
    this.target = { ...options.input.target };
    this.terminal = { ...options.input.terminal };
    this.expectedFingerprint = options.input.expectedHostKeyFingerprint;
    this.environment = { ...(options.input.environment ?? {}) };
    this.startupCommand = options.input.startupCommand;
    this.keepAliveIntervalMs = (options.input.keepAliveInterval ?? 30) * 1_000;
    this.egressMode = options.input.egress?.mode;
    this.route = (options.input.route?.jumps ?? []).map((hop) => ({
      target: { ...hop.target },
      expectedFingerprint: hop.expectedHostKeyFingerprint,
      ...consumeAuthentication(hop.authentication)
    }));
    const authentication = consumeAuthentication(options.input.authentication);
    this.privateKey = authentication.privateKey;
    this.passphrase = authentication.passphrase;
    this.password = authentication.password;
    options.input.route = undefined;
    options.input.environment = undefined;
    options.input.startupCommand = undefined;
  }

  start() {
    if (this.state !== "created") return;
    this.armLifetimeTimers();
    void this.connect();
  }

  private send(message: ServerMessage) {
    return this.context.send(message);
  }

  private sendState(state: SessionState | "error", reason?: string, message?: string) {
    this.send({ type: "session.state", sessionId: this.id, state, reason, message });
  }

  private async connect() {
    this.state = "connecting";
    this.sendState("connecting");
    this.connectStartedAt = Date.now();
    try {
      this.state = "authenticating";
      this.sendState("authenticating");
      let previousClient: Client | undefined;
      for (const hop of this.route) {
        const connected = await this.connectClient(hop.target, hop, hop.expectedFingerprint, previousClient);
        this.auxiliaryClients.push(connected.client);
        previousClient = connected.client;
      }
      const finalCredentials = { privateKey: this.privateKey, passphrase: this.passphrase, password: this.password };
      const connected = await this.connectClient(this.target, finalCredentials, this.expectedFingerprint, previousClient);
      this.client = connected.client;
      this.socket = connected.socket;
      this.wipeCredentials();
      if (this.closed) return;
      this.stream = await this.openShell(this.client);
      if (this.closed) return;
      this.bindStream(this.stream);
      this.state = "connected";
      this.touch();
      this.sendState("connected");
      if (this.startupCommand) this.stream.write(`${this.startupCommand}\r`);
      this.metrics?.recordSessionOpen("success");
      this.metrics?.recordConnectDuration(Date.now() - this.connectStartedAt);
      this.logger.info("session.open.succeeded", {
        connection_id: this.connectionId,
        session_id: this.id,
        principal_id_hash: hashLogValue(this.principalId),
        target_host_hash: hashLogValue(this.target.host),
        target_port: this.target.port
      });
    } catch (error) {
      this.wipeCredentials();
      if (this.closed) return;
      const mapped = mapSshError(error, this.hostKeyRejected);
      this.metrics?.recordSessionOpen("failure", mapped.code);
      this.metrics?.recordConnectDuration(Date.now() - this.connectStartedAt);
      if (mapped.code === "TARGET_DENIED") this.metrics?.recordTargetDenied(targetDeniedReason(mapped.message));
      this.sendError(mapped);
      this.finish(1, mapped.code, mapped.message);
    }
  }

  private async connectClient(target: SessionOpenMessage["target"], credential: SessionCredential, expectedFingerprint: string | undefined, previousClient?: Client) {
    const throughAgent = !previousClient && this.egressMode === "client-agent";
    const resolved = throughAgent
      ? { originalHost: target.host, address: target.host, family: 4 as const, port: target.port }
      : await resolveTarget(this.config, target.host, target.port);
    if (this.closed) throw new GatewayError("SSH_CONNECTION_FAILED", "SSH session was closed");
    const socket = previousClient
      ? await new Promise<ClientChannel>((resolve, reject) => previousClient.forwardOut("127.0.0.1", 0, resolved.address, resolved.port, (error, stream) => error ? reject(error) : resolve(stream)))
      : throughAgent
        ? await this.requireAgentBridge().open(this.principalId, target.host, target.port)
        : await connectResolvedTarget(resolved, this.config.connectTimeoutMs);
    this.routeSockets.push(socket);
    const authoritative = this.knownHosts ? await this.knownHosts.get(this.knownHostIdentity(target)) : undefined;
    const client = new Client();
    this.bindClientEvents(client);
    const endpoint = throughAgent ? { host: target.host, port: target.port } : sshConnectEndpoint(resolved);
    const config: ConnectConfig = {
      host: endpoint.host,
      port: endpoint.port,
      username: target.username,
      sock: socket,
      privateKey: credential.privateKey,
      passphrase: credential.passphrase,
      password: credential.password,
      readyTimeout: sshReadyTimeoutMs(this.config),
      keepaliveInterval: this.keepAliveIntervalMs,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        void this.verifyHostKey(target, key, authoritative?.fingerprint ?? expectedFingerprint, authoritative?.version).then(verify, () => verify(false));
      }
    };
    try {
      await this.awaitReady(client, config);
      return { client, socket };
    } finally {
      config.privateKey = undefined;
      config.passphrase = undefined;
      config.password = undefined;
      credential.privateKey?.fill(0);
      credential.passphrase?.fill(0);
      credential.privateKey = undefined;
      credential.passphrase = undefined;
      credential.password = undefined;
    }
  }

  private requireAgentBridge() {
    if (!this.agentBridge) throw new GatewayError("AGENT_UNAVAILABLE", "Local-agent bridge is disabled", true);
    return this.agentBridge;
  }

  private bindClientEvents(client: Client) {
    client.on("keyboard-interactive", (_name, _instructions, _language, prompts: Prompt[], finish) => {
      if (this.closed) return finish([]);
      this.pendingAuth?.([]);
      this.pendingAuth = finish;
      this.touch();
      this.send({
        type: "auth.prompt",
        sessionId: this.id,
        prompts: prompts.map((prompt) => ({ prompt: prompt.prompt, echo: Boolean(prompt.echo) }))
      });
    });
    client.on("error", (error) => {
      if (this.state === "connecting" || this.state === "authenticating" || this.closed) return;
      const mapped = mapSshError(error, this.hostKeyRejected);
      this.sendError(mapped);
      this.finish(1, mapped.code, mapped.message);
    });
    client.on("close", () => {
      if (!this.closed && this.state === "connected") this.finish(0, "remote-closed");
    });
  }

  private awaitReady(client: Client, config: ConnectConfig) {
    return new Promise<void>((resolve, reject) => {
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
      client.connect(config);
    });
  }

  private openShell(client: Client) {
    return new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: this.terminal.term, cols: this.terminal.cols, rows: this.terminal.rows }, { env: this.environment }, (error, stream) => {
        if (error) reject(error);
        else resolve(stream);
      });
    });
  }

  private bindStream(stream: ClientChannel) {
    stream.on("data", (chunk: Buffer) => this.queueOutput(chunk.toString("utf8")));
    stream.stderr.on("data", (chunk: Buffer) => this.queueOutput(chunk.toString("utf8")));
    stream.on("close", (code?: number) => this.finish(code ?? 0, "remote-closed"));
  }

  private verifyHostKey(target: SessionOpenMessage["target"], key: Buffer, expectedFingerprint?: string, authoritativeVersion?: number) {
    const fingerprint = fingerprintHostKey(key);
    const algorithm = hostKeyAlgorithm(key);
    if (expectedFingerprint === fingerprint) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const kind = expectedFingerprint ? "changed" : "unknown";
      let timedOut = false;
      this.pendingHostKey?.(false);
      this.pendingHostKey = async (accept) => {
        clearTimeout(this.hostKeyTimer);
        this.hostKeyTimer = undefined;
        this.pendingHostKey = undefined;
        let trusted = accept;
        if (trusted && this.knownHosts) {
          try {
            trusted = await this.knownHosts.accept(
              this.knownHostIdentity(target),
              { algorithm, fingerprint },
              this.context.principal.id,
              authoritativeVersion
            ) === "accepted";
          } catch {
            trusted = false;
          }
        }
        this.hostKeyRejected = !trusted;
        if (!timedOut) this.metrics?.recordHostKey(kind, trusted ? "accept" : "reject");
        resolve(trusted);
      };
      this.hostKeyTimer = setTimeout(() => {
        timedOut = true;
        this.metrics?.recordHostKey(kind, "timeout");
        this.pendingHostKey?.(false);
      }, this.config.hostKeyTimeoutMs);
      this.hostKeyTimer.unref();
      this.send({
        type: "hostkey.prompt",
        sessionId: this.id,
        kind,
        host: target.host,
        port: target.port,
        algorithm,
        fingerprint,
        previousFingerprint: expectedFingerprint
      });
    });
  }

  private knownHostIdentity(target: SessionOpenMessage["target"] = this.target) {
    return {
      tenantId: this.context.principal.tenantId,
      host: normalizeKnownHost(target.host),
      port: target.port
    };
  }

  write(data: string) {
    if (this.closed || !this.stream) return;
    this.touch();
    this.metrics?.recordBytes("in", Buffer.byteLength(data, "utf8"));
    this.stream.write(data);
  }

  resize(cols: number, rows: number) {
    if (this.closed) return;
    this.terminal.cols = cols;
    this.terminal.rows = rows;
    this.touch();
    this.stream?.setWindow(rows, cols, 0, 0);
  }

  answerHostKey(accept: boolean) {
    this.touch();
    this.pendingHostKey?.(accept);
  }

  answerAuthPrompt(answers: string[]) {
    this.touch();
    const finish = this.pendingAuth;
    this.pendingAuth = undefined;
    finish?.(answers);
  }

  private requireConnectedClient() {
    if (this.closed || this.state !== "connected" || !this.client) throw new GatewayError("SSH_CONNECTION_FAILED", "SSH session is not connected", true);
    this.touch();
    return this.client;
  }

  private async withSftp<T>(run: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = this.requireConnectedClient();
    const sftp = await callbackPromise<SFTPWrapper>((done) => client.sftp(done));
    try {
      return await run(sftp);
    } finally {
      sftp.end();
    }
  }

  async sftpHome() {
    return this.withSftp((sftp) => callbackPromise<string>((done) => sftp.realpath(".", done)));
  }

  async sftpList(path: string) {
    const normalized = remotePath(path);
    return this.withSftp(async (sftp) => {
      const rows = await callbackPromise<any[]>((done) => sftp.readdir(normalized, done));
      return rows
        .filter((row) => row.filename !== "." && row.filename !== "..")
        .map((row) => ({
          name: row.filename,
          path: posixPath.join(normalized, row.filename),
          type: remoteFileType(row.attrs?.mode),
          size: row.attrs?.size ?? 0,
          mode: row.attrs?.mode ?? 0,
          modifiedAt: (row.attrs?.mtime ?? 0) * 1_000
        }))
        .sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === "directory" ? -1 : 1);
    });
  }

  async sftpStat(path: string) {
    const normalized = remotePath(path);
    return this.withSftp(async (sftp) => {
      const stats = await callbackPromise<any>((done) => sftp.stat(normalized, done));
      return {
        name: posixPath.basename(normalized),
        path: normalized,
        type: remoteFileType(stats.mode),
        size: stats.size ?? 0,
        mode: stats.mode ?? 0,
        modifiedAt: (stats.mtime ?? 0) * 1_000
      };
    });
  }

  async sftpMkdir(path: string) {
    await this.withSftp((sftp) => callbackPromise<void>((done) => sftp.mkdir(remotePath(path), { mode: 0o755 }, done)));
  }

  async sftpRename(from: string, to: string) {
    await this.withSftp((sftp) => callbackPromise<void>((done) => sftp.rename(remotePath(from), remotePath(to), done)));
  }

  async sftpRemove(path: string, directory: boolean) {
    await this.withSftp(async (sftp) => {
      const normalized = removableRemotePath(path);
      if (directory) await removeRemoteTree(sftp, normalized);
      else await callbackPromise<void>((done) => sftp.unlink(normalized, done));
    });
  }

  async sftpWrite(path: string, offset: number, data: Buffer, truncate: boolean) {
    return this.withSftp(async (sftp) => {
      const handle = await callbackPromise<Buffer>((done) => sftp.open(remotePath(path), truncate && offset === 0 ? "w" : "r+", { mode: 0o600 }, done));
      try {
        await callbackPromise<void>((done) => sftp.write(handle, data, 0, data.length, offset, done));
        return data.length;
      } finally {
        await callbackPromise<void>((done) => sftp.close(handle, done)).catch(() => undefined);
      }
    });
  }

  async sftpRead(path: string, offset: number, length: number) {
    return this.withSftp(async (sftp) => {
      const handle = await callbackPromise<Buffer>((done) => sftp.open(remotePath(path), "r", done));
      try {
        const stats = await callbackPromise<any>((done) => sftp.fstat(handle, done));
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, Number(stats.size ?? 0) - offset)));
        if (!buffer.length) return { data: buffer, bytesRead: 0, size: Number(stats.size ?? 0), eof: true };
        const bytesRead = await new Promise<number>((resolve, reject) => sftp.read(handle, buffer, 0, buffer.length, offset, (error, count) => error ? reject(error) : resolve(count)));
        return { data: buffer.subarray(0, bytesRead), bytesRead, size: Number(stats.size ?? 0), eof: offset + bytesRead >= Number(stats.size ?? 0) };
      } finally {
        await callbackPromise<void>((done) => sftp.close(handle, done)).catch(() => undefined);
      }
    });
  }

  private ensureRemoteTunnelHandler() {
    if (this.remoteTunnelHandler || !this.client) return;
    this.remoteTunnelHandler = (info: any, accept: () => ClientChannel, reject: () => void) => {
      const tunnel = [...this.remoteTunnels.values()].find((candidate) => candidate.bindPort === info.destPort && candidate.bindAddress === info.destIP);
      if (!tunnel || tunnel.state !== "active") return reject();
      const stream = accept();
      void connectResolvedTarget(tunnel.resolvedTarget, this.config.connectTimeoutMs).then((destination) => {
        stream.pipe(destination).pipe(stream);
        stream.on("error", () => destination.destroy());
        destination.on("error", () => stream.destroy());
      }).catch(() => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });
    };
    this.client.on("tcp connection", this.remoteTunnelHandler);
  }

  async startRemoteTunnel(input: { bindAddress: string; bindPort: number; targetHost: string; targetPort: number; label?: string }) {
    const client = this.requireConnectedClient();
    if (!["127.0.0.1", "::1", "localhost"].includes(input.bindAddress)) throw new GatewayError("TUNNEL_FAILED", "Web remote forwarding may only bind to remote loopback");
    const resolvedTarget = await resolveForwardTarget(this.config, input.targetHost, input.targetPort);
    const bindPort = await callbackPromise<number>((done) => client.forwardIn(input.bindAddress, input.bindPort, done));
    const tunnel: RemoteTunnelRecord = {
      id: randomUUID(),
      sessionId: this.id,
      kind: "remote",
      label: input.label || `R ${bindPort} -> ${input.targetHost}:${input.targetPort}`,
      bindAddress: input.bindAddress,
      bindPort,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      state: "active",
      resolvedTarget
    };
    this.remoteTunnels.set(tunnel.id, tunnel);
    this.ensureRemoteTunnelHandler();
    this.publishTunnels();
    return this.tunnelView(tunnel);
  }

  listTunnels() {
    return [...this.remoteTunnels.values()].map((tunnel) => this.tunnelView(tunnel));
  }

  async stopTunnel(tunnelId: string) {
    const tunnel = this.remoteTunnels.get(tunnelId);
    if (!tunnel || !this.client) return false;
    tunnel.state = "stopping";
    this.publishTunnels();
    await callbackPromise<void>((done) => this.client!.unforwardIn(tunnel.bindAddress, tunnel.bindPort, done));
    this.remoteTunnels.delete(tunnelId);
    this.publishTunnels();
    return true;
  }

  private tunnelView(tunnel: RemoteTunnelRecord): RemoteTunnelView {
    const { resolvedTarget: _resolvedTarget, ...view } = tunnel;
    return view;
  }

  private publishTunnels() {
    this.send({ type: "tunnel.changed", sessionId: this.id, tunnels: this.listTunnels() });
  }

  async installPublicKey(publicKey: string) {
    const normalized = publicKey.trim();
    if (/[\x00-\x1f\x7f`$\\]/.test(normalized) || normalized.includes("\n") || !/^(ssh-\w+|ecdsa-\S+) [A-Za-z0-9+/=]+ ?.*$/.test(normalized)) {
      throw new GatewayError("KEY_OPERATION_FAILED", "Public key format is invalid");
    }
    const quoted = normalized.replace(/'/g, `'\\''`);
    const command = [
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
      "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
      `grep -qxF '${quoted}' ~/.ssh/authorized_keys || echo '${quoted}' >> ~/.ssh/authorized_keys`
    ].join(" && ");
    const stream = await callbackPromise<ClientChannel>((done) => this.requireConnectedClient().exec(command, done));
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 4_096 - stderr.length); });
      stream.once("close", (code?: number) => code === 0 ? resolve() : reject(new Error(stderr || "Remote key installation failed")));
      stream.once("error", reject);
      stream.resume();
    });
  }

  private queueOutput(data: string) {
    if (this.closed || !data) return;
    this.touch();
    this.outputChunks.push(data);
    this.outputBytes += Buffer.byteLength(data, "utf8");
    if (this.outputBytes >= this.config.outputBatchBytes) this.flushOutput();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushOutput(), 16);
      this.flushTimer.unref();
    }
  }

  private flushOutput() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.outputChunks.length || this.closed) return;
    const data = this.outputChunks.join("");
    this.outputChunks = [];
    this.metrics?.recordBytes("out", Buffer.byteLength(data, "utf8"));
    this.outputBytes = 0;
    this.send({ type: "session.output", sessionId: this.id, data });
    this.checkBackpressure();
  }

  private checkBackpressure() {
    if (!this.stream || this.closed || this.context.bufferedAmount() <= this.config.outputHighWaterBytes) return;
    this.stream.pause();
    this.metrics?.recordBackpressure("pause");
    if (!this.backpressureTimer) {
      this.backpressureTimer = setTimeout(() => {
        const error = new GatewayError("BACKPRESSURE_LIMIT", "Terminal client is not consuming output fast enough");
        this.metrics?.recordBackpressure("close");
        this.sendError(error);
        this.finish(1, error.code, error.message);
      }, this.config.backpressureTimeoutMs);
      this.backpressureTimer.unref();
    }
    if (!this.backpressurePoll) {
      this.backpressurePoll = setInterval(() => {
        if (this.context.bufferedAmount() > this.config.outputLowWaterBytes) return;
        clearTimeout(this.backpressureTimer);
        clearInterval(this.backpressurePoll);
        this.backpressureTimer = undefined;
        this.backpressurePoll = undefined;
        this.metrics?.recordBackpressure("resume");
        this.stream?.resume();
      }, 50);
      this.backpressurePoll.unref();
    }
  }

  private armLifetimeTimers() {
    this.maxAgeTimer = setTimeout(() => this.finish(0, "max-session-time"), this.config.maxSessionMs);
    this.maxAgeTimer.unref();
    this.touch();
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const error = new GatewayError("IDLE_TIMEOUT", "SSH session was closed after being idle");
      this.sendError(error);
      this.finish(0, error.code, error.message);
    }, this.config.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private wipeCredentials() {
    this.privateKey?.fill(0);
    this.passphrase?.fill(0);
    this.privateKey = undefined;
    this.passphrase = undefined;
    this.password = undefined;
    for (const hop of this.route) {
      hop.privateKey?.fill(0);
      hop.passphrase?.fill(0);
      hop.privateKey = undefined;
      hop.passphrase = undefined;
      hop.password = undefined;
    }
  }

  private sendError(error: GatewayError) {
    if (this.errorSent || this.closed) return;
    this.errorSent = true;
    this.send({ type: "error", sessionId: this.id, code: error.code, message: error.message, retryable: error.retryable });
  }

  close(reason = "user-closed") {
    this.finish(0, reason);
  }

  private finish(code: number, reason: string, message?: string) {
    if (this.closed) return;
    this.state = "closing";
    this.flushOutput();
    this.closed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxAgeTimer);
    clearTimeout(this.hostKeyTimer);
    clearTimeout(this.backpressureTimer);
    clearInterval(this.backpressurePoll);
    this.pendingHostKey?.(false);
    this.pendingHostKey = undefined;
    this.pendingAuth?.([]);
    this.pendingAuth = undefined;
    this.wipeCredentials();
    if (this.client && this.remoteTunnelHandler) this.client.off("tcp connection", this.remoteTunnelHandler);
    this.remoteTunnelHandler = undefined;
    for (const tunnel of this.remoteTunnels.values()) {
      try { this.client?.unforwardIn(tunnel.bindAddress, tunnel.bindPort); } catch {}
    }
    this.remoteTunnels.clear();
    try { this.stream?.destroy(); } catch {}
    try { this.client?.end(); } catch {}
    for (const client of this.auxiliaryClients.splice(0)) {
      try { client.end(); } catch {}
    }
    for (const socket of this.routeSockets.splice(0)) {
      try { socket.destroy(); } catch {}
    }
    try { this.socket?.destroy(); } catch {}
    this.state = "closed";
    this.sendState("closed", reason, message);
    if (!this.exitSent) {
      this.exitSent = true;
      this.send({ type: "session.exit", sessionId: this.id, code, reason, message });
    }
    this.metrics?.recordSessionDuration(Date.now() - this.startedAt);
    this.onClose(this);
    this.logger.info("session.closed", {
      connection_id: this.connectionId,
      session_id: this.id,
      principal_id_hash: hashLogValue(this.principalId),
      target_host_hash: hashLogValue(this.target.host),
      target_port: this.target.port,
      reason
    });
  }
}

export function errorCodeOf(error: unknown): ErrorCode {
  return normalizeError(error).code;
}