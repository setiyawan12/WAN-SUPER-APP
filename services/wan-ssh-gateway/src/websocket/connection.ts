import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { Authenticator } from "../auth/index.js";
import { assertSamePrincipal } from "../auth/index.js";
import type { Principal } from "../auth/principal.js";
import type { GatewayConfig } from "../config.js";
import { CLOSE_CODES, GatewayError, normalizeError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { hashLogValue } from "../observability/logger.js";
import { authFailureReason, type GatewayMetrics } from "../observability/metrics.js";
import {
  parseAuthMessage,
  parseClientMessage,
  parseJsonMessage,
  PROTOCOL_VERSION,
  validatePrivateKeySize,
  type ServerMessage,
  type SessionOpenMessage
} from "../protocol.js";
import type { ConnectionContext, SessionService } from "../sessions/types.js";
import { sendMessage } from "./send.js";

type Dependencies = {
  config: GatewayConfig;
  authenticator: Authenticator;
  sessions: SessionService;
  logger: Logger;
  metrics?: GatewayMetrics;
  clientAddress?: string;
};

export function handleConnection(socket: WebSocket, dependencies: Dependencies) {
  const { config, authenticator, sessions, logger, metrics, clientAddress } = dependencies;
  const clientAddressHash = clientAddress ? hashLogValue(clientAddress) : undefined;
  const connectionId = randomUUID();
  let principal: Principal | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let processing = Promise.resolve();

  const send = (message: ServerMessage) => sendMessage(socket, message);
  const closeSessions = (reason: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    clearTimeout(expiryTimer);
    sessions.closeConnection(connectionId, reason);
  };
  const fail = (error: unknown, requestId?: string, sessionId?: string) => {
    const normalized = normalizeError(error);
    if (normalized.code === "AUTH_REQUIRED" || normalized.code === "AUTH_INVALID") {
      metrics?.recordAuth("failure", authFailureReason(normalized.code));
    }
    send({ type: "error", requestId, sessionId, code: normalized.code, message: normalized.message, retryable: normalized.retryable });
    logger.warn("ws.message.failed", {
      connection_id: connectionId,
      principal_id_hash: principal ? hashLogValue(principal.id) : undefined,
      request_id: requestId,
      session_id: sessionId,
      error_code: normalized.code
    });
    if (normalized.closeCode) {
      closeSessions(`fatal-${normalized.code.toLowerCase()}`);
      if (socket.readyState === WebSocket.OPEN) socket.close(normalized.closeCode, normalized.message.slice(0, 120));
    }
  };
  const armExpiry = () => {
    clearTimeout(expiryTimer);
    if (!principal?.expiresAt) return;
    const remaining = principal.expiresAt - Date.now();
    if (remaining <= 0) {
      closeSessions("authentication-expired");
      socket.close(CLOSE_CODES.authInvalid, "Authentication expired");
      return;
    }
    expiryTimer = setTimeout(() => {
      closeSessions("authentication-expired");
      socket.close(CLOSE_CODES.authInvalid, "Authentication expired");
    }, remaining);
    expiryTimer.unref();
  };

  const authTimer = setTimeout(() => {
    fail(new GatewayError("AUTH_REQUIRED", "Authentication frame was not received"));
    socket.close(CLOSE_CODES.authTimeout, "Authentication timeout");
  }, config.authTimeoutMs);
  authTimer.unref();

  const processMessage = async (raw: RawData, isBinary: boolean) => {
    let parsed: unknown;
    let requestId: string | undefined;
    let sessionId: string | undefined;
    try {
      if (isBinary) throw new GatewayError("MESSAGE_INVALID", "Binary frames are not supported", false, CLOSE_CODES.messageInvalid);
      const text = raw.toString();
      try {
        parsed = parseJsonMessage(text, config.maxMessageBytes);
      } catch {
        throw new GatewayError("MESSAGE_INVALID", "Message is not valid or exceeds the configured size limit", false, CLOSE_CODES.messageInvalid);
      }
      if (parsed && typeof parsed === "object") {
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate.requestId === "string") requestId = candidate.requestId;
        if (typeof candidate.sessionId === "string") sessionId = candidate.sessionId;
      }

      if (!principal) {
        if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "auth") {
          throw new GatewayError("AUTH_REQUIRED", "Authenticate before sending session messages", false, CLOSE_CODES.authInvalid);
        }
        const authMessage = parseAuthMessage(parsed);
        principal = await authenticator.authenticate(authMessage);
        clearTimeout(authTimer);
        armExpiry();
        send({
          type: "auth.ok",
          requestId: authMessage.requestId,
          protocolVersion: PROTOCOL_VERSION,
          principal: { kind: principal.kind, uid: principal.uid },
          expiresAt: principal.expiresAt
        });
        metrics?.recordAuth("success", "ok");
        logger.info("ws.auth.succeeded", {
          connection_id: connectionId,
          principal_id_hash: hashLogValue(principal.id),
          client_address_hash: clientAddressHash
        });
        return;
      }

      if ((parsed as { type?: unknown }).type === "auth") {
        throw new GatewayError("MESSAGE_INVALID", "Connection is already authenticated", false, CLOSE_CODES.messageInvalid);
      }
      if ((parsed as { type?: unknown }).type === "auth.refresh") {
        const message = parseClientMessage(parsed);
        if (message.type !== "auth.refresh") throw new GatewayError("MESSAGE_INVALID", "Invalid refresh message", false, CLOSE_CODES.messageInvalid);
        if (principal.expiresAt && Date.now() >= principal.expiresAt) throw new GatewayError("AUTH_INVALID", "Authentication has expired", false, CLOSE_CODES.authInvalid);
        const refreshed = await authenticator.refresh(principal, message.token);
        assertSamePrincipal(principal, refreshed);
        principal = refreshed;
        armExpiry();
        send({ type: "auth.refreshed", requestId: message.requestId, expiresAt: refreshed.expiresAt! });
        return;
      }

      const message = parseClientMessage(parsed);
      const context: ConnectionContext = {
        id: connectionId,
        principal,
        send,
        bufferedAmount: () => socket.bufferedAmount
      };
      if (message.type === "session.open") {
        validatePrivateKeySize(message, config.maxPrivateKeyBytes);
        const openedSessionId = await sessions.open(context, message as SessionOpenMessage);
        send({ type: "session.opened", requestId: message.requestId, sessionId: openedSessionId });
        sessions.start(context, openedSessionId);
        return;
      }
      await sessions.handle(context, message);
    } catch (error) {
      if (error instanceof GatewayError) fail(error, requestId, sessionId);
      else fail(new GatewayError("MESSAGE_INVALID", "Message schema is invalid", false, CLOSE_CODES.messageInvalid), requestId, sessionId);
    }
  };

  socket.on("message", (raw, isBinary) => {
    processing = processing.then(() => processMessage(raw, isBinary)).catch((error) => fail(error));
  });
  socket.on("close", () => closeSessions("socket-closed"));
  socket.on("error", () => closeSessions("socket-error"));
  logger.info("ws.connected", { connection_id: connectionId, client_address_hash: clientAddressHash });
}