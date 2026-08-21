import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import type { IncomingMessage, Server } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { Authenticator } from "../auth/index.js";
import { assertSamePrincipal } from "../auth/index.js";
import type { Principal } from "../auth/principal.js";
import type { GatewayConfig } from "../config.js";
import { CLOSE_CODES, GatewayError, PROTOCOL_VERSION } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { hashLogValue } from "../observability/logger.js";
import { parseJsonMessage } from "../protocol.js";
import { FRAME_CLOSE, FRAME_DATA, decodeBridgeFrame, encodeBridgeFrame } from "./frames.js";
import {
  agentRefreshMessageSchema,
  agentRegisterMessageSchema,
  bridgeFailedMessageSchema,
  bridgeOpenedMessageSchema,
  type BridgeOpenMessage
} from "./hub-protocol.js";

export const AGENT_UPGRADE_PATH = "/v1/agent";

export interface AgentBridgeConnector {
  open(principalId: string, host: string, port: number): Promise<Duplex>;
  isConnected(principalId: string): boolean;
}

type PendingOpen = {
  channel: AgentBridgeSocket;
  resolve(stream: Duplex): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

type RegisteredAgent = {
  socket: WebSocket;
  principal: Principal;
  pending: Map<string, PendingOpen>;
  channels: Map<string, AgentBridgeSocket>;
  expiryTimer?: NodeJS.Timeout;
};

class AgentBridgeSocket extends Duplex {
  private remoteClosed = false;

  constructor(
    readonly channelId: string,
    private readonly agent: RegisteredAgent,
    private readonly maxBufferedBytes: number
  ) {
    super();
  }

  _read() {}

  _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.agent.socket.readyState !== WebSocket.OPEN) return callback(new GatewayError("AGENT_UNAVAILABLE", "Local agent disconnected", true));
    if (this.agent.socket.bufferedAmount > this.maxBufferedBytes) return callback(new GatewayError("BACKPRESSURE_LIMIT", "Local-agent bridge buffer limit reached", true));
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.agent.socket.send(encodeBridgeFrame(FRAME_DATA, this.channelId, payload), { binary: true }, callback);
  }

  receive(payload: Buffer) {
    if (!this.destroyed) this.push(payload);
  }

  remoteClose() {
    this.remoteClosed = true;
    if (!this.destroyed) this.push(null);
    this.destroy();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.agent.channels.delete(this.channelId);
    if (!this.remoteClosed && this.agent.socket.readyState === WebSocket.OPEN) {
      this.agent.socket.send(encodeBridgeFrame(FRAME_CLOSE, this.channelId), { binary: true }, () => callback(error));
      return;
    }
    callback(error);
  }
}

export class AgentHub implements AgentBridgeConnector {
  private readonly webSocketServer: WebSocketServer;
  private readonly agents = new Map<string, RegisteredAgent>();

  constructor(
    server: Server,
    private readonly config: GatewayConfig,
    private readonly authenticator: Authenticator,
    private readonly logger: Logger,
    private readonly isReady: () => boolean
  ) {
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== AGENT_UPGRADE_PATH) return;
      if (!this.isReady() || !config.agentBridgeEnabled) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });
    this.webSocketServer.on("connection", (socket, request: IncomingMessage) => this.handleConnection(socket, request));
  }

  isConnected(principalId: string) {
    return this.agents.get(principalId)?.socket.readyState === WebSocket.OPEN;
  }

  open(principalId: string, host: string, port: number) {
    const agent = this.agents.get(principalId);
    if (!agent || agent.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new GatewayError("AGENT_UNAVAILABLE", "No paired local agent is online for this account", true));
    }
    const requestId = randomUUID();
    const channelId = randomUUID();
    const channel = new AgentBridgeSocket(channelId, agent, this.config.agentMaxBufferedBytes);
    return new Promise<Duplex>((resolve, reject) => {
      const timeout = setTimeout(() => {
        agent.pending.delete(requestId);
        channel.destroy();
        reject(new GatewayError("AGENT_CONNECTION_FAILED", "Local agent did not open the target connection in time", true));
      }, this.config.agentOpenTimeoutMs);
      timeout.unref();
      agent.pending.set(requestId, { channel, resolve, reject, timeout });
      const message: BridgeOpenMessage = { type: "bridge.open", requestId, channelId, host, port };
      agent.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        agent.pending.delete(requestId);
        channel.destroy();
        reject(new GatewayError("AGENT_UNAVAILABLE", "Unable to send a request to the local agent", true));
      });
    });
  }

  close(code = 1012, reason = "Service restart") {
    for (const agent of this.agents.values()) agent.socket.close(code, reason);
    this.webSocketServer.close();
    this.agents.clear();
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage) {
    let agent: RegisteredAgent | undefined;
    let processing = Promise.resolve();
    const registrationTimer = setTimeout(() => socket.close(CLOSE_CODES.authInvalid, "Agent registration timeout"), this.config.agentRegistrationTimeoutMs);
    registrationTimer.unref();

    const cleanup = (reason: string) => {
      clearTimeout(registrationTimer);
      if (!agent) return;
      clearTimeout(agent.expiryTimer);
      if (this.agents.get(agent.principal.id) === agent) this.agents.delete(agent.principal.id);
      for (const pending of agent.pending.values()) {
        clearTimeout(pending.timeout);
        pending.channel.destroy();
        pending.reject(new GatewayError("AGENT_UNAVAILABLE", "Local agent disconnected", true));
      }
      agent.pending.clear();
      for (const channel of agent.channels.values()) channel.remoteClose();
      agent.channels.clear();
      this.logger.info("agent.disconnected", { principal_id_hash: hashLogValue(agent.principal.id), reason });
    };

    const armExpiry = () => {
      if (!agent) return;
      clearTimeout(agent.expiryTimer);
      if (!agent.principal.expiresAt) return;
      const remaining = agent.principal.expiresAt - Date.now();
      if (remaining <= 0) return socket.close(CLOSE_CODES.authInvalid, "Agent authentication expired");
      agent.expiryTimer = setTimeout(() => socket.close(CLOSE_CODES.authInvalid, "Agent authentication expired"), remaining);
      agent.expiryTimer.unref();
    };

    const handleText = async (raw: string) => {
      const value = parseJsonMessage(raw, this.config.maxMessageBytes);
      if (!agent) {
        const registration = agentRegisterMessageSchema.parse(value);
        const principal = await this.authenticator.authenticate({
          type: "auth",
          requestId: registration.requestId,
          protocolVersion: PROTOCOL_VERSION,
          mode: registration.mode,
          token: registration.token
        });
        clearTimeout(registrationTimer);
        agent = { socket, principal, pending: new Map(), channels: new Map() };
        const previous = this.agents.get(principal.id);
        if (previous && previous !== agent) previous.socket.close(1012, "Agent replaced by a newer connection");
        this.agents.set(principal.id, agent);
        armExpiry();
        socket.send(JSON.stringify({
          type: "agent.registered",
          requestId: registration.requestId,
          protocolVersion: PROTOCOL_VERSION,
          principal: { uid: principal.uid },
          expiresAt: principal.expiresAt
        }));
        this.logger.info("agent.registered", {
          principal_id_hash: hashLogValue(principal.id),
          remote_address_hash: request.socket.remoteAddress ? hashLogValue(request.socket.remoteAddress) : undefined
        });
        return;
      }
      const kind = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
      if (kind === "agent.auth.refresh") {
        const message = agentRefreshMessageSchema.parse(value);
        const refreshed = await this.authenticator.refresh(agent.principal, message.token);
        assertSamePrincipal(agent.principal, refreshed);
        agent.principal = refreshed;
        armExpiry();
        socket.send(JSON.stringify({ type: "agent.auth.refreshed", requestId: message.requestId, expiresAt: refreshed.expiresAt }));
        return;
      }
      if (kind === "bridge.opened") {
        const message = bridgeOpenedMessageSchema.parse(value);
        const pending = agent.pending.get(message.requestId);
        if (!pending || pending.channel.channelId !== message.channelId) return;
        clearTimeout(pending.timeout);
        agent.pending.delete(message.requestId);
        agent.channels.set(message.channelId, pending.channel);
        pending.resolve(pending.channel);
        return;
      }
      if (kind === "bridge.failed") {
        const message = bridgeFailedMessageSchema.parse(value);
        const pending = agent.pending.get(message.requestId);
        if (!pending || pending.channel.channelId !== message.channelId) return;
        clearTimeout(pending.timeout);
        agent.pending.delete(message.requestId);
        pending.channel.destroy();
        pending.reject(new GatewayError("AGENT_CONNECTION_FAILED", message.message, true));
        return;
      }
      throw new GatewayError("MESSAGE_INVALID", "Unsupported local-agent message");
    };

    const handleBinary = (raw: RawData) => {
      if (!agent) throw new GatewayError("AUTH_REQUIRED", "Register the local agent before opening bridge channels");
      const frame = decodeBridgeFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      const channel = agent.channels.get(frame.channelId);
      if (!channel) return;
      if (frame.kind === FRAME_DATA) channel.receive(frame.payload);
      else channel.remoteClose();
    };

    socket.on("message", (raw, isBinary) => {
      processing = processing.then(() => isBinary ? handleBinary(raw) : handleText(raw.toString())).catch((error) => {
        const message = error instanceof Error ? error.message : "Agent message failed";
        this.logger.warn("agent.message.failed", { reason: message });
        socket.close(CLOSE_CODES.messageInvalid, message.slice(0, 120));
      });
    });
    socket.on("close", () => cleanup("socket-closed"));
    socket.on("error", () => cleanup("socket-error"));
  }
}
