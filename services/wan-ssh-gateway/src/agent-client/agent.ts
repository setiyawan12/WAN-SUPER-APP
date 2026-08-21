import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import WebSocket, { type RawData } from "ws";
import { FRAME_CLOSE, FRAME_DATA, decodeBridgeFrame, encodeBridgeFrame } from "../agent/frames.js";
import { PROTOCOL_VERSION } from "../errors.js";
import type { EgressPolicy } from "./policy.js";
import { AgentAuthError, type TokenSource } from "./token.js";

export type AgentLogger = (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

export type AgentRunnerOptions = {
  url: string;
  tokens: TokenSource;
  policy: EgressPolicy;
  log: AgentLogger;
  connectTimeoutMs?: number;
  maxChannels?: number;
  maxBufferedBytes?: number;
  reconnect?: boolean;
  onRegistered?(info: { uid?: string; expiresAt?: number }): void;
  onStopped?(reason: string): void;
};

const DRAIN_POLL_MS = 25;
const REFRESH_SKEW_MS = 5 * 60_000;
const MIN_REFRESH_DELAY_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;

type Channel = { socket: Socket; closing: boolean; drainTimer?: NodeJS.Timeout };

function textOf(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function portOf(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
}

/**
 * Sisi laptop dari bridge egress. Gateway di VPS tidak pernah menyentuh
 * jaringan target: ia hanya mengirim `bridge.open`, dan proses inilah yang
 * membuka TCP-nya — lewat tabel rute dan DNS mesin ini, termasuk VPN yang
 * sedang aktif.
 */
export class AgentRunner {
  private readonly endpoint: string;
  private readonly connectTimeoutMs: number;
  private readonly maxChannels: number;
  private readonly maxBufferedBytes: number;
  private readonly reconnect: boolean;
  private readonly channels = new Map<string, Channel>();
  private socket?: WebSocket;
  private registered = false;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly options: AgentRunnerOptions) {
    this.endpoint = `${options.url.replace(/^http/, "ws")}/v1/agent`;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.maxChannels = options.maxChannels ?? 64;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
    this.reconnect = options.reconnect !== false;
  }

  start() {
    if (this.stopped) throw new Error("Agent runner was already stopped");
    this.connect();
  }

  stop(reason = "Agent stopped") {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    for (const id of [...this.channels.keys()]) this.closeChannel(id, false);
    this.socket?.close(1000, reason.slice(0, 120));
    this.socket = undefined;
    this.options.onStopped?.(reason);
  }

  private connect() {
    if (this.stopped) return;
    this.registered = false;
    const socket = new WebSocket(this.endpoint, { maxPayload: 16 * 1_048_576, handshakeTimeout: this.connectTimeoutMs });
    this.socket = socket;
    socket.on("open", () => void this.register(socket));
    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary) this.handleFrame(raw);
        else this.handleText(raw.toString());
      } catch (error) {
        this.options.log("warn", "Agent message failed", { reason: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => this.options.log("warn", "Agent connection error", { reason: error.message }));
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.registered = false;
      clearTimeout(this.refreshTimer);
      for (const id of [...this.channels.keys()]) this.closeChannel(id, false);
      if (this.stopped) return;
      this.options.log("warn", "Agent disconnected", { code, reason: reason.toString() || undefined });
      this.scheduleReconnect();
    });
  }

  private async register(socket: WebSocket) {
    try {
      const token = await this.options.tokens.get();
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: "agent.register",
        requestId: randomUUID(),
        protocolVersion: PROTOCOL_VERSION,
        mode: this.options.tokens.mode,
        ...(token ? { token } : {})
      }));
    } catch (error) {
      const fatal = error instanceof AgentAuthError && error.fatal;
      this.options.log("error", error instanceof Error ? error.message : String(error));
      socket.close(1000, "Agent authentication unavailable");
      if (fatal) this.stop("Pairing is no longer valid. Run `wan-ssh-agent pair` again.");
    }
  }

  private scheduleReconnect() {
    if (!this.reconnect) return this.stop("Agent connection closed");
    this.attempt += 1;
    const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (this.attempt - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.options.log("info", "Reconnecting to the gateway", { inMs: delay, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private scheduleRefresh(expiresAt?: number) {
    clearTimeout(this.refreshTimer);
    if (!expiresAt || this.options.tokens.mode !== "firebase") return;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, expiresAt - Date.now() - REFRESH_SKEW_MS);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
    this.refreshTimer.unref?.();
  }

  private async refresh() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      const token = await this.options.tokens.get(true);
      if (!token || this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "agent.auth.refresh", requestId: randomUUID(), token }));
    } catch (error) {
      const fatal = error instanceof AgentAuthError && error.fatal;
      this.options.log("error", error instanceof Error ? error.message : String(error));
      if (fatal) return this.stop("Pairing is no longer valid. Run `wan-ssh-agent pair` again.");
      this.refreshTimer = setTimeout(() => void this.refresh(), MIN_REFRESH_DELAY_MS);
      this.refreshTimer.unref?.();
    }
  }

  private sendJson(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private handleText(raw: string) {
    const value = JSON.parse(raw) as Record<string, unknown>;
    switch (value.type) {
      case "agent.registered": {
        this.registered = true;
        this.attempt = 0;
        const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : undefined;
        const uid = (value.principal as { uid?: string } | undefined)?.uid;
        this.scheduleRefresh(expiresAt);
        this.options.log("info", "Agent registered with the gateway", { uid, expiresAt });
        this.options.onRegistered?.({ uid, expiresAt });
        return;
      }
      case "agent.auth.refreshed":
        this.scheduleRefresh(typeof value.expiresAt === "number" ? value.expiresAt : undefined);
        return;
      case "bridge.open":
        return void this.openBridge(value);
      default:
        this.options.log("warn", "Unsupported gateway message", { type: String(value.type) });
    }
  }

  private async openBridge(value: Record<string, unknown>) {
    const requestId = textOf(value.requestId, 64);
    const channelId = textOf(value.channelId, 64);
    const host = textOf(value.host, 253);
    const port = portOf(value.port);
    if (!requestId || !channelId || !host || !port) return this.options.log("warn", "Malformed bridge.open was ignored");
    const fail = (reason: string) => {
      this.options.log("warn", "Bridge refused", { host, port, reason });
      this.sendJson({ type: "bridge.failed", requestId, channelId, message: reason.slice(0, 500) });
    };
    if (!this.registered) return fail("Local agent is not registered");
    if (this.channels.size >= this.maxChannels) return fail("Local agent channel limit reached");

    const socket = this.socket;
    let resolved;
    try {
      resolved = await this.options.policy.resolve(host, port);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Target was rejected by the agent policy");
    }
    if (this.socket !== socket || socket?.readyState !== WebSocket.OPEN) return;

    const target = connect({ host: resolved.address, port: resolved.port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      target.destroy();
      fail(`Timed out connecting to ${host}:${port}`);
    }, this.connectTimeoutMs);
    timer.unref?.();
    target.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(`${host}:${port} is unreachable from the agent (${error.message})`);
    });
    target.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return target.destroy();
      target.setNoDelay(true);
      const channel: Channel = { socket: target, closing: false };
      this.channels.set(channelId, channel);
      this.sendJson({ type: "bridge.opened", requestId, channelId });
      this.options.log("info", "Bridge opened", { host, port, address: resolved.address });
      this.wire(channelId, channel);
    });
  }

  private wire(channelId: string, channel: Channel) {
    channel.socket.on("data", (chunk: Buffer) => {
      if (this.socket?.readyState !== WebSocket.OPEN) return this.closeChannel(channelId, false);
      this.socket.send(encodeBridgeFrame(FRAME_DATA, channelId, chunk), { binary: true });
      this.applyBackpressure(channelId, channel);
    });
    channel.socket.on("close", () => this.closeChannel(channelId, true));
    channel.socket.on("error", () => this.closeChannel(channelId, true));
  }

  /**
   * Output terminal yang membanjir tidak boleh menumpuk di buffer WebSocket,
   * karena gateway memutus channel begitu melewati `agentMaxBufferedBytes`.
   */
  private applyBackpressure(channelId: string, channel: Channel) {
    if (channel.drainTimer || (this.socket?.bufferedAmount ?? 0) <= this.maxBufferedBytes) return;
    channel.socket.pause();
    const poll = () => {
      channel.drainTimer = undefined;
      if (!this.channels.has(channelId)) return;
      if (this.socket?.readyState !== WebSocket.OPEN) return this.closeChannel(channelId, false);
      if (this.socket.bufferedAmount <= this.maxBufferedBytes) return void channel.socket.resume();
      channel.drainTimer = setTimeout(poll, DRAIN_POLL_MS);
      channel.drainTimer.unref?.();
    };
    channel.drainTimer = setTimeout(poll, DRAIN_POLL_MS);
    channel.drainTimer.unref?.();
  }

  private closeChannel(channelId: string, notify: boolean) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    clearTimeout(channel.drainTimer);
    channel.socket.destroy();
    if (notify && !channel.closing && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeBridgeFrame(FRAME_CLOSE, channelId), { binary: true });
    }
  }

  private handleFrame(raw: RawData) {
    const frame = decodeBridgeFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
    const channel = this.channels.get(frame.channelId);
    if (!channel) return;
    if (frame.kind === FRAME_DATA) {
      channel.socket.write(frame.payload);
      return;
    }
    channel.closing = true;
    this.channels.delete(frame.channelId);
    clearTimeout(channel.drainTimer);
    channel.socket.end();
  }
}

export function startAgent(options: AgentRunnerOptions) {
  const runner = new AgentRunner(options);
  runner.start();
  return runner;
}
