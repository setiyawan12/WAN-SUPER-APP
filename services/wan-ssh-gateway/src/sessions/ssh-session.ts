import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { Client, type ClientChannel, type ConnectConfig, type Prompt } from "ssh2";
import type { GatewayConfig } from "../config.js";
import { GatewayError, normalizeError, type ErrorCode } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { hashLogValue } from "../observability/logger.js";
import { targetDeniedReason, type GatewayMetrics } from "../observability/metrics.js";
import type { ServerMessage, SessionOpenMessage } from "../protocol.js";
import type { ConnectionContext } from "./types.js";
import { fingerprintHostKey, hostKeyAlgorithm } from "./host-key.js";
import { connectResolvedTarget, resolveTarget, sshConnectEndpoint } from "./target-policy.js";

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
  close(reason?: string): void;
}

type SessionOptions = {
  config: GatewayConfig;
  context: ConnectionContext;
  input: SessionOpenMessage;
  metrics?: GatewayMetrics;
  logger: Logger;
  onClose(session: SshSession): void;
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

export class SshSession implements ManagedSession {
  readonly id = randomUUID();
  readonly connectionId: string;
  readonly principalId: string;
  state: SessionState = "created";
  private readonly config: GatewayConfig;
  private readonly context: ConnectionContext;
  private readonly logger: Logger;
  private readonly metrics?: GatewayMetrics;
  private readonly onClose: (session: SshSession) => void;
  private readonly startedAt = Date.now();
  private connectStartedAt = 0;
  private readonly target: SessionOpenMessage["target"];
  private readonly terminal: SessionOpenMessage["terminal"];
  private readonly expectedFingerprint?: string;
  private client?: Client;
  private socket?: Socket;
  private stream?: ClientChannel;
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
    this.onClose = options.onClose;
    this.connectionId = options.context.id;
    this.principalId = options.context.principal.id;
    this.target = { ...options.input.target };
    this.terminal = { ...options.input.terminal };
    this.expectedFingerprint = options.input.expectedHostKeyFingerprint;
    if (options.input.authentication.method === "privateKey") {
      this.privateKey = Buffer.from(options.input.authentication.privateKey, "utf8");
      this.passphrase = options.input.authentication.passphrase
        ? Buffer.from(options.input.authentication.passphrase, "utf8")
        : undefined;
      options.input.authentication.privateKey = "";
      options.input.authentication.passphrase = undefined;
    } else {
      this.password = options.input.authentication.password;
      options.input.authentication.password = "";
    }
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
    let connectConfig: ConnectConfig | undefined;
    try {
      const resolved = await resolveTarget(this.config, this.target.host, this.target.port);
      if (this.closed) return;
      this.socket = await connectResolvedTarget(resolved, this.config.connectTimeoutMs);
      if (this.closed) return;
      this.state = "authenticating";
      this.sendState("authenticating");
      this.client = new Client();
      this.bindClientEvents(this.client);
      const endpoint = sshConnectEndpoint(resolved);
      connectConfig = {
        host: endpoint.host,
        port: endpoint.port,
        username: this.target.username,
        sock: this.socket,
        privateKey: this.privateKey,
        passphrase: this.passphrase,
        password: this.password,
        readyTimeout: sshReadyTimeoutMs(this.config),
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        tryKeyboard: true,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          void this.verifyHostKey(key).then(verify, () => verify(false));
        }
      };
      await this.awaitReady(this.client, connectConfig);
      connectConfig.privateKey = undefined;
      connectConfig.passphrase = undefined;
      connectConfig.password = undefined;
      this.wipeCredentials();
      if (this.closed) return;
      this.stream = await this.openShell(this.client);
      if (this.closed) return;
      this.bindStream(this.stream);
      this.state = "connected";
      this.touch();
      this.sendState("connected");
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
      if (connectConfig) {
        connectConfig.privateKey = undefined;
        connectConfig.passphrase = undefined;
        connectConfig.password = undefined;
      }
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
      client.shell({ term: this.terminal.term, cols: this.terminal.cols, rows: this.terminal.rows }, (error, stream) => {
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

  private verifyHostKey(key: Buffer) {
    const fingerprint = fingerprintHostKey(key);
    const algorithm = hostKeyAlgorithm(key);
    if (this.expectedFingerprint === fingerprint) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const kind = this.expectedFingerprint ? "changed" : "unknown";
      let timedOut = false;
      this.pendingHostKey?.(false);
      this.pendingHostKey = (accept) => {
        clearTimeout(this.hostKeyTimer);
        this.hostKeyTimer = undefined;
        this.pendingHostKey = undefined;
        this.hostKeyRejected = !accept;
        if (!timedOut) this.metrics?.recordHostKey(kind, accept ? "accept" : "reject");
        resolve(accept);
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
        host: this.target.host,
        port: this.target.port,
        algorithm,
        fingerprint,
        previousFingerprint: this.expectedFingerprint
      });
    });
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
    try { this.stream?.destroy(); } catch {}
    try { this.client?.end(); } catch {}
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