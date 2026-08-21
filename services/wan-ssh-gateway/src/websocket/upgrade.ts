import type { IncomingMessage, Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { AGENT_UPGRADE_PATH } from "../agent/hub.js";
import type { Authenticator } from "../auth/index.js";
import type { GatewayConfig } from "../config.js";
import { hashLogValue, type Logger } from "../observability/logger.js";
import type { GatewayMetrics } from "../observability/metrics.js";
import { resolveClientAddress } from "../security/net.js";
import { assertAllowedOrigin } from "../security/origin.js";
import { SlidingWindowRateLimiter } from "../security/rate-limit.js";
import type { SessionService } from "../sessions/types.js";
import { handleConnection } from "./connection.js";

type Dependencies = {
  server: Server;
  config: GatewayConfig;
  authenticator: Authenticator;
  sessions: SessionService;
  logger: Logger;
  metrics?: GatewayMetrics;
  isReady(): boolean;
};

export function attachWebSocketServer(dependencies: Dependencies) {
  const { server, config, authenticator, sessions, logger, metrics, isReady } = dependencies;
  const connectLimiter = new SlidingWindowRateLimiter(config.connectRateLimit, config.connectRateWindowMs);
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
  server.on("upgrade", (request, socket, head) => {
    try {
      // Hub local-agent memasang listener `upgrade` sendiri untuk path ini.
      // Tanpa pengecualian ini handler klien ikut menulis 503 ke socket yang
      // sama dan merusak handshake agent.
      if (config.agentBridgeEnabled && request.url === AGENT_UPGRADE_PATH) return;
      if (!isReady() || request.url !== "/v1/ws") {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      assertAllowedOrigin(config, request.headers.origin);
      const clientAddress = resolveClientAddress(config, request);
      if (!connectLimiter.allow(clientAddress)) {
        logger.warn("ws.upgrade.rate_limited", { client_address_hash: hashLogValue(clientAddress) });
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  webSocketServer.on("connection", (socket, request: IncomingMessage) => {
    const liveSocket = socket as WebSocket & { isAlive?: boolean };
    liveSocket.isAlive = true;
    liveSocket.on("pong", () => { liveSocket.isAlive = true; });
    handleConnection(liveSocket, {
      config,
      authenticator,
      sessions,
      metrics,
      logger,
      clientAddress: resolveClientAddress(config, request)
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      const liveSocket = socket as WebSocket & { isAlive?: boolean };
      if (liveSocket.isAlive === false) {
        liveSocket.terminate();
        continue;
      }
      liveSocket.isAlive = false;
      liveSocket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    webSocketServer,
    close(code = CLOSE_SERVICE_RESTART, reason = "Service restart") {
      clearInterval(heartbeat);
      for (const socket of webSocketServer.clients) socket.close(code, reason);
      webSocketServer.close();
    }
  };
}

const CLOSE_SERVICE_RESTART = 1012;