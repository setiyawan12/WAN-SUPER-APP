import type {
  RemoteTerminalTransport,
  SshRuntimeCapabilities,
  SshTransportEvent,
  WebSessionOpenInput
} from "./contract";

export type GatewayRuntimeConfig = {
  service: "wan-ssh-gateway";
  protocolVersion: 1;
  authMode: "dev-anonymous" | "firebase";
};

type ServerMessage =
  | { type: "auth.ok"; requestId: string; protocolVersion: 1; principal: { kind: "development" | "firebase"; uid: string }; expiresAt?: number }
  | { type: "auth.refreshed"; requestId: string; expiresAt: number }
  | { type: "session.opened"; requestId: string; sessionId: string }
  | { type: "session.closed"; requestId: string; sessionId: string }
  | SshTransportEvent
  | { type: "error"; requestId?: string; sessionId?: string; code: string; message: string; retryable: boolean };

type PendingRequest = {
  expectedType: ServerMessage["type"];
  resolve(message: ServerMessage): void;
  reject(error: Error): void;
  timeout: number;
};

export type GatewayTokenProvider = (forceRefresh: boolean) => Promise<string>;

export async function loadGatewayRuntimeConfig(baseUrl = window.location.origin): Promise<GatewayRuntimeConfig> {
  const response = await fetch(new URL("/runtime-config.json", baseUrl), { cache: "no-store" });
  if (!response.ok) throw new GatewayClientError("GATEWAY_UNAVAILABLE", "Gateway runtime configuration is unavailable", true);
  const value = await response.json() as Partial<GatewayRuntimeConfig>;
  if (value.service !== "wan-ssh-gateway" || value.protocolVersion !== 1 || (value.authMode !== "dev-anonymous" && value.authMode !== "firebase")) {
    throw new GatewayClientError("PROTOCOL_UNSUPPORTED", "Gateway runtime configuration is incompatible");
  }
  return value as GatewayRuntimeConfig;
}

export class GatewayClientError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "GatewayClientError";
  }
}

export class WebSocketRemoteTerminalTransport implements RemoteTerminalTransport {
  readonly capabilities: SshRuntimeCapabilities = {
    runtime: "web-local",
    remoteTerminal: true,
    hostProfiles: false,
    localShell: false,
    sftp: false,
    tunnels: false,
    recording: false,
    biometric: false,
    openSshImport: false,
    firebaseSync: false
  };

  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private runtimeConfig?: GatewayRuntimeConfig;
  private readonly listeners = new Set<(event: SshTransportEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Set<string>();
  private refreshTimer?: number;

  constructor(
    private readonly baseUrl = window.location.origin,
    private readonly tokenProvider?: GatewayTokenProvider
  ) {}

  async health() {
    const response = await fetch(new URL("/healthz", this.baseUrl), { cache: "no-store" });
    if (!response.ok) throw new GatewayClientError("GATEWAY_UNAVAILABLE", "Gateway unavailable", true);
    const health = await response.json() as { ok?: boolean; version?: string; protocolVersion?: number };
    if (!health.ok) throw new GatewayClientError("GATEWAY_UNAVAILABLE", "Gateway unavailable", true);
    if (health.protocolVersion !== 1) throw new GatewayClientError("PROTOCOL_UNSUPPORTED", "Gateway protocol version is incompatible");
    return { ok: true, version: health.version ?? "unknown", protocolVersion: 1 as const };
  }

  async open(input: WebSessionOpenInput | Record<string, unknown>) {
    await this.ensureConnected();
    const message = await this.request({ type: "session.open", ...input }, "session.opened");
    if (message.type !== "session.opened") throw new GatewayClientError("INTERNAL", "Unexpected gateway response");
    this.sessions.add(message.sessionId);
    return { sessionId: message.sessionId };
  }

  write(sessionId: string, data: string) {
    this.send({ type: "session.input", sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number) {
    this.send({ type: "session.resize", sessionId, cols, rows });
  }

  answerHostKey(sessionId: string, accept: boolean) {
    this.send({ type: "hostkey.answer", requestId: crypto.randomUUID(), sessionId, accept });
  }

  answerAuthPrompt(sessionId: string, answers: string[]) {
    this.send({ type: "auth.answer", requestId: crypto.randomUUID(), sessionId, answers });
  }

  async close(sessionId: string) {
    if (!this.isOpen()) {
      this.sessions.delete(sessionId);
      return;
    }
    const response = await this.request({ type: "session.close", sessionId }, "session.closed");
    if (response.type === "session.closed") this.sessions.delete(sessionId);
  }

  onEvent(listener: (event: SshTransportEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.disconnect("Client disposed");
    this.listeners.clear();
  }

  async reconnect() {
    this.disconnect("Client reconnect");
    await this.ensureConnected();
  }

  disconnect(reason = "Client disconnected") {
    window.clearTimeout(this.refreshTimer);
    this.rejectPending(new GatewayClientError("CONNECTION_LOST", "Gateway connection closed", true));
    this.socket?.close(1000, reason);
    this.socket = undefined;
    this.sessions.clear();
  }

  private async ensureConnected() {
    if (this.isOpen()) return;
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => { this.connectPromise = undefined; });
    }
    await this.connectPromise;
  }

  private async connect() {
    this.runtimeConfig = await loadGatewayRuntimeConfig(this.baseUrl);
    this.capabilities.runtime = this.runtimeConfig.authMode === "firebase" ? "web-cloud" : "web-local";
    const url = new URL("/v1/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", (event) => this.handleClose(event.code));
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        socket.removeEventListener("open", onOpen);
        reject(new GatewayClientError("GATEWAY_UNAVAILABLE", "Unable to open gateway connection", true));
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });

    const requestId = crypto.randomUUID();
    const mode = this.runtimeConfig.authMode;
    const token = mode === "firebase" ? await this.requireToken(false) : undefined;
    const response = await this.requestRaw({ type: "auth", requestId, protocolVersion: 1, mode, ...(token ? { token } : {}) }, "auth.ok");
    if (response.type !== "auth.ok") throw new GatewayClientError("AUTH_INVALID", "Gateway authentication failed");
    this.scheduleRefresh(response.expiresAt);
  }

  private async requireToken(forceRefresh: boolean) {
    if (!this.tokenProvider) throw new GatewayClientError("AUTH_REQUIRED", "Gateway authentication is required");
    return this.tokenProvider(forceRefresh);
  }

  private scheduleRefresh(expiresAt?: number) {
    window.clearTimeout(this.refreshTimer);
    if (!expiresAt || this.runtimeConfig?.authMode !== "firebase") return;
    const delay = Math.max(1_000, expiresAt - Date.now() - 60_000);
    this.refreshTimer = window.setTimeout(() => void this.refreshAuthentication(), delay);
  }

  private async refreshAuthentication() {
    try {
      const token = await this.requireToken(true);
      const response = await this.request({ type: "auth.refresh", token }, "auth.refreshed");
      if (response.type === "auth.refreshed") this.scheduleRefresh(response.expiresAt);
    } catch {
      this.socket?.close(4401, "Authentication refresh failed");
    }
  }

  private request(message: Record<string, unknown>, expectedType: ServerMessage["type"]) {
    const requestId = typeof message.requestId === "string" ? message.requestId : crypto.randomUUID();
    return this.requestRaw({ ...message, requestId }, expectedType);
  }

  private requestRaw(message: Record<string, unknown>, expectedType: ServerMessage["type"]) {
    const requestId = String(message.requestId);
    return new Promise<ServerMessage>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayClientError("SSH_TIMEOUT", "Gateway request timed out", true));
      }, 20_000);
      this.pending.set(requestId, { expectedType, resolve, reject, timeout });
      try {
        this.send(message);
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: Record<string, unknown>) {
    if (!this.isOpen()) throw new GatewayClientError("CONNECTION_LOST", "Gateway connection is not open", true);
    this.socket!.send(JSON.stringify(message));
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      this.socket?.close(4400, "Invalid server message");
      return;
    }
    if (message.type === "error") {
      const error = new GatewayClientError(message.code, message.message, message.retryable);
      if (message.requestId) this.settle(message.requestId, message, error);
      if (message.sessionId) this.emit({ type: "session.state", sessionId: message.sessionId, state: "error", reason: message.code, message: message.message });
      return;
    }
    if ("requestId" in message && typeof message.requestId === "string") this.settle(message.requestId, message);
    if (message.type === "session.opened") this.sessions.add(message.sessionId);
    if (message.type === "session.closed") this.sessions.delete(message.sessionId);
    if (["session.state", "session.output", "session.exit", "hostkey.prompt", "auth.prompt"].includes(message.type)) {
      this.emit(message as SshTransportEvent);
    }
  }

  private settle(requestId: string, message: ServerMessage, error?: Error) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    if (error) pending.reject(error);
    else if (message.type !== pending.expectedType) pending.reject(new GatewayClientError("PROTOCOL_UNSUPPORTED", "Unexpected gateway response"));
    else pending.resolve(message);
  }

  private handleClose(code?: number) {
    this.socket = undefined;
    window.clearTimeout(this.refreshTimer);
    const restarted = code === 1012;
    const error = new GatewayClientError(
      restarted ? "SERVICE_RESTART" : "CONNECTION_LOST",
      restarted ? "Gateway restarted; reconnect the socket and open a new session" : "Gateway connection lost",
      true
    );
    this.rejectPending(error);
    for (const sessionId of this.sessions) {
      this.emit({ type: "session.state", sessionId, state: "disconnected", reason: error.code, message: error.message });
      this.emit({ type: "session.exit", sessionId, code: 1, reason: error.code, message: error.message });
    }
    this.sessions.clear();
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emit(event: SshTransportEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}