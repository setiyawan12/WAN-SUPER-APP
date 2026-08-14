import type { GatewayConfig } from "../config.js";
import { CLOSE_CODES, GatewayError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import type { GatewayMetrics } from "../observability/metrics.js";
import type { ClientMessage, SessionOpenMessage } from "../protocol.js";
import { SshSession, type ManagedSession } from "./ssh-session.js";
import type { ConnectionContext, SessionService } from "./types.js";

type SessionFactory = (options: {
  config: GatewayConfig;
  context: ConnectionContext;
  input: SessionOpenMessage;
  logger: Logger;
  metrics?: GatewayMetrics;
  onClose(session: ManagedSession): void;
}) => ManagedSession;

export class SessionManager implements SessionService {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly byConnection = new Map<string, Set<string>>();
  private readonly byPrincipal = new Map<string, Set<string>>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
    private readonly factory: SessionFactory = (options) => new SshSession({ ...options, onClose: options.onClose }),
    private readonly metrics?: GatewayMetrics
  ) {}

  get activeCount() {
    return this.sessions.size;
  }

  async open(context: ConnectionContext, input: SessionOpenMessage) {
    const principalSessions = this.byPrincipal.get(context.principal.id);
    if (this.sessions.size >= this.config.maxSessionsTotal || (principalSessions?.size ?? 0) >= this.config.maxSessionsPerUser) {
      this.metrics?.recordSessionOpen("failure", "SESSION_LIMIT");
      throw new GatewayError("SESSION_LIMIT", "SSH session limit reached", true, CLOSE_CODES.limit);
    }
    const session = this.factory({
      config: this.config,
      context,
      input,
      logger: this.logger,
      metrics: this.metrics,
      onClose: (closed) => this.remove(closed)
    });
    this.sessions.set(session.id, session);
    this.addIndex(this.byConnection, context.id, session.id);
    this.addIndex(this.byPrincipal, context.principal.id, session.id);
    return session.id;
  }

  start(context: ConnectionContext, sessionId: string) {
    this.owned(sessionId, context.id, context.principal.id).start();
  }

  handle(context: ConnectionContext, message: Exclude<ClientMessage, SessionOpenMessage>) {
    if (message.type === "auth.refresh") throw new GatewayError("MESSAGE_INVALID", "Unexpected authentication refresh");
    const session = this.owned(message.sessionId, context.id, context.principal.id);
    switch (message.type) {
      case "session.input":
        if (Buffer.byteLength(message.data, "utf8") > 65_536) throw new GatewayError("MESSAGE_INVALID", "Terminal input exceeds the configured size limit");
        session.write(message.data);
        break;
      case "session.resize":
        session.resize(message.cols, message.rows);
        break;
      case "hostkey.answer":
        session.answerHostKey(message.accept);
        break;
      case "auth.answer":
        session.answerAuthPrompt(message.answers);
        break;
      case "session.close":
        session.close();
        context.send({ type: "session.closed", requestId: message.requestId, sessionId: message.sessionId });
        break;
    }
  }

  owned(sessionId: string, connectionId: string, principalId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.connectionId !== connectionId || session.principalId !== principalId) {
      throw new GatewayError("SESSION_NOT_FOUND", "SSH session was not found");
    }
    return session;
  }

  closeConnection(connectionId: string, reason: string) {
    for (const sessionId of [...(this.byConnection.get(connectionId) ?? [])]) this.sessions.get(sessionId)?.close(reason);
  }

  closeAll(reason: string) {
    for (const session of [...this.sessions.values()]) session.close(reason);
  }

  private addIndex(index: Map<string, Set<string>>, key: string, sessionId: string) {
    const entries = index.get(key) ?? new Set<string>();
    entries.add(sessionId);
    index.set(key, entries);
  }

  private remove(session: ManagedSession) {
    if (!this.sessions.delete(session.id)) return;
    this.removeIndex(this.byConnection, session.connectionId, session.id);
    this.removeIndex(this.byPrincipal, session.principalId, session.id);
  }

  private removeIndex(index: Map<string, Set<string>>, key: string, sessionId: string) {
    const entries = index.get(key);
    entries?.delete(sessionId);
    if (!entries?.size) index.delete(key);
  }
}