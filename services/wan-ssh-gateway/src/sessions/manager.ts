import type { AgentBridgeConnector } from "../agent/hub.js";
import type { GatewayConfig } from "../config.js";
import { CLOSE_CODES, GatewayError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import type { GatewayMetrics } from "../observability/metrics.js";
import type { ClientMessage, SessionOpenMessage } from "../protocol.js";
import type { KnownHostStore } from "./known-host-store.js";
import { knownHostDocumentId, normalizeKnownHost } from "./known-host-store.js";
import { generateSshKey, inspectSshKey, runAgentDiagnostics, runTargetDiagnostics } from "./operations.js";
import { SshSession, type ManagedSession } from "./ssh-session.js";
import type { ConnectionContext, SessionService } from "./types.js";

type SessionFactory = (options: {
  config: GatewayConfig;
  context: ConnectionContext;
  input: SessionOpenMessage;
  logger: Logger;
  metrics?: GatewayMetrics;
  knownHosts?: KnownHostStore;
  agentBridge?: AgentBridgeConnector;
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
    private readonly metrics?: GatewayMetrics,
    private readonly knownHosts?: KnownHostStore,
    private readonly agentBridge?: AgentBridgeConnector
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
      knownHosts: this.knownHosts,
      agentBridge: this.agentBridge,
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
    if (message.type === "diagnostics.run") return this.runDiagnostics(context, message);
    if (message.type === "knownhost.list") return this.listKnownHosts(context, message.requestId);
    if (message.type === "knownhost.remove") return this.removeKnownHost(context, message);
    if (message.type === "key.generate") return this.generateKey(context, message);
    if (message.type === "key.inspect") return this.inspectKey(context, message);
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
      case "sftp.home":
        return this.sftp(context, message.requestId, message.sessionId, "SFTP home lookup", async () => {
          const path = await this.requireOperation(session.sftpHome, "SFTP is unavailable").call(session);
          context.send({ type: "sftp.home.result", requestId: message.requestId, sessionId: message.sessionId, path });
        });
      case "sftp.list":
        return this.sftp(context, message.requestId, message.sessionId, "SFTP directory listing", async () => {
          const entries = await this.requireOperation(session.sftpList, "SFTP is unavailable").call(session, message.path);
          context.send({ type: "sftp.list.result", requestId: message.requestId, sessionId: message.sessionId, entries });
        });
      case "sftp.stat":
        return this.sftp(context, message.requestId, message.sessionId, "SFTP metadata lookup", async () => {
          const entry = await this.requireOperation(session.sftpStat, "SFTP is unavailable").call(session, message.path);
          context.send({ type: "sftp.stat.result", requestId: message.requestId, sessionId: message.sessionId, entry });
        });
      case "sftp.mkdir":
        return this.sftpMutation(context, message.requestId, message.sessionId, () => this.requireOperation(session.sftpMkdir, "SFTP is unavailable").call(session, message.path));
      case "sftp.rename":
        return this.sftpMutation(context, message.requestId, message.sessionId, () => this.requireOperation(session.sftpRename, "SFTP is unavailable").call(session, message.from, message.to));
      case "sftp.remove":
        return this.sftpMutation(context, message.requestId, message.sessionId, () => this.requireOperation(session.sftpRemove, "SFTP is unavailable").call(session, message.path, message.directory));
      case "sftp.write":
        return this.sftp(context, message.requestId, message.sessionId, "SFTP upload", async () => {
          const data = Buffer.from(message.data, "base64");
          const written = await this.requireOperation(session.sftpWrite, "SFTP is unavailable").call(session, message.path, message.offset, data, message.truncate);
          data.fill(0);
          context.send({ type: "sftp.write.result", requestId: message.requestId, sessionId: message.sessionId, written });
        });
      case "sftp.read":
        return this.sftp(context, message.requestId, message.sessionId, "SFTP download", async () => {
          const result = await this.requireOperation(session.sftpRead, "SFTP is unavailable").call(session, message.path, message.offset, message.length);
          context.send({ type: "sftp.read.result", requestId: message.requestId, sessionId: message.sessionId, data: result.data.toString("base64"), bytesRead: result.bytesRead, size: result.size, eof: result.eof });
        });
      case "tunnel.start":
        return this.tunnel(context, message.requestId, message.sessionId, async () => {
          await this.requireOperation(session.startRemoteTunnel, "Remote forwarding is unavailable").call(session, message);
          this.sendTunnels(context, message.requestId, session);
        });
      case "tunnel.list":
        return this.tunnel(context, message.requestId, message.sessionId, async () => this.sendTunnels(context, message.requestId, session));
      case "tunnel.stop":
        return this.tunnel(context, message.requestId, message.sessionId, async () => {
          await this.requireOperation(session.stopTunnel, "Remote forwarding is unavailable").call(session, message.tunnelId);
          this.sendTunnels(context, message.requestId, session);
        });
      case "key.install":
        return this.keyOperation(context, message.requestId, message.sessionId, async () => {
          await this.requireOperation(session.installPublicKey, "Key installation is unavailable").call(session, message.publicKey);
          context.send({ type: "key.installed", requestId: message.requestId, sessionId: message.sessionId, installed: true });
        });
    }
  }

  private async runDiagnostics(context: ConnectionContext, message: Extract<ClientMessage, { type: "diagnostics.run" }>) {
    const phases = message.egress?.mode === "client-agent"
      ? await runAgentDiagnostics(this.agentBridge, context.principal.id, message.target)
      : await runTargetDiagnostics(this.config, message.target);
    context.send({ type: "diagnostics.result", requestId: message.requestId, address: message.target.host, port: message.target.port, phases });
  }

  private async listKnownHosts(context: ConnectionContext, requestId: string) {
    const records = await this.knownHosts?.list?.(context.principal.tenantId) ?? [];
    context.send({
      type: "knownhost.list.result",
      requestId,
      entries: records.map((record) => ({
        id: knownHostDocumentId(record),
        hostPattern: `${record.host}:${record.port}`,
        fingerprint: record.fingerprint,
        keyType: record.algorithm,
        vaultId: "personal",
        firstSeenAt: Date.parse(record.createdAt),
        updatedAt: Date.parse(record.updatedAt)
      }))
    });
  }

  private async removeKnownHost(context: ConnectionContext, message: Extract<ClientMessage, { type: "knownhost.remove" }>) {
    const removed = await this.knownHosts?.remove?.({ tenantId: context.principal.tenantId, host: normalizeKnownHost(message.host), port: message.port }, context.principal.id) ?? false;
    context.send({ type: "knownhost.removed", requestId: message.requestId, removed });
  }

  private generateKey(context: ConnectionContext, message: Extract<ClientMessage, { type: "key.generate" }>) {
    try {
      const result = generateSshKey(message);
      context.send({ type: "key.generated", requestId: message.requestId, ...result });
    } catch (error) {
      throw error instanceof GatewayError ? error : new GatewayError("KEY_OPERATION_FAILED", "SSH key generation failed");
    } finally {
      message.passphrase = undefined;
    }
  }

  private inspectKey(context: ConnectionContext, message: Extract<ClientMessage, { type: "key.inspect" }>) {
    try {
      const result = inspectSshKey(message.privateKey, message.passphrase);
      context.send({ type: "key.inspected", requestId: message.requestId, ...result });
    } finally {
      message.privateKey = "";
      message.passphrase = undefined;
    }
  }

  private async sftp(context: ConnectionContext, requestId: string, sessionId: string, operation: string, run: () => Promise<void>) {
    try {
      await run();
    } catch {
      throw new GatewayError("SFTP_FAILED", `${operation} failed`, true);
    }
  }

  private sftpMutation(context: ConnectionContext, requestId: string, sessionId: string, run: () => Promise<void>) {
    return this.sftp(context, requestId, sessionId, "SFTP mutation", async () => {
      await run();
      context.send({ type: "sftp.mutation.result", requestId, sessionId, ok: true });
    });
  }

  private async tunnel(_context: ConnectionContext, _requestId: string, _sessionId: string, run: () => Promise<void>) {
    try {
      await run();
    } catch {
      throw new GatewayError("TUNNEL_FAILED", "Remote forwarding operation failed", true);
    }
  }

  private async keyOperation(_context: ConnectionContext, _requestId: string, _sessionId: string, run: () => Promise<void>) {
    try {
      await run();
    } catch {
      throw new GatewayError("KEY_OPERATION_FAILED", "SSH key installation failed");
    }
  }

  private sendTunnels(context: ConnectionContext, requestId: string, session: ManagedSession) {
    const tunnels = this.requireOperation(session.listTunnels, "Remote forwarding is unavailable").call(session);
    context.send({ type: "tunnel.result", requestId, sessionId: session.id, tunnels });
  }

  private requireOperation<T extends (...args: any[]) => any>(operation: T | undefined, message: string): T {
    if (!operation) throw new GatewayError("PROTOCOL_UNSUPPORTED", message);
    return operation;
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