import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp, type ReadinessState } from "./app.js";
import { createAuthenticator } from "./auth/index.js";
import type { Authenticator } from "./auth/index.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { CLOSE_CODES } from "./errors.js";
import { createLogger } from "./observability/logger.js";
import { GatewayMetrics } from "./observability/metrics.js";
import { SessionManager } from "./sessions/manager.js";
import type { SessionService } from "./sessions/types.js";
import { attachWebSocketServer } from "./websocket/upgrade.js";

export type GatewayRuntime = ReturnType<typeof createGatewayRuntime>;

type GatewayRuntimeDependencies = {
  authenticator?: Authenticator;
  sessions?: SessionService;
  metrics?: GatewayMetrics;
};

export function createGatewayRuntime(config: GatewayConfig, dependencies: GatewayRuntimeDependencies = {}) {
  const readiness: ReadinessState = { ready: false };
  const logger = createLogger(config.logLevel);
  const metrics = dependencies.metrics ?? new GatewayMetrics();
  const sessions = dependencies.sessions ?? new SessionManager(config, logger, undefined, metrics);
  const server = createServer(createApp(config, readiness, metrics));
  const webSockets = attachWebSocketServer({
    server,
    config,
    authenticator: dependencies.authenticator ?? createAuthenticator(config),
    sessions,
    logger,
    metrics,
    isReady: () => readiness.ready
  });
  metrics.snapshot = () => ({
    ready: readiness.ready,
    sessionsActive: sessions.activeCount,
    sessionsLimit: config.maxSessionsTotal,
    wsConnections: webSockets.webSocketServer.clients.size
  });
  let shuttingDown = false;

  return {
    server,
    readiness,
    sessions,
    metrics,
    get activeConnectionCount() {
      return webSockets.webSocketServer.clients.size;
    },
    async listen(port = config.port, host = config.bindHost) {
      await listen(server, port, host);
      readiness.ready = true;
      const address = server.address();
      logger.info("gateway.ready", { reason: typeof address === "object" && address ? `${address.address}:${address.port}` : String(address) });
      return address;
    },
    async shutdown(reason = "service-restart") {
      if (shuttingDown) return;
      shuttingDown = true;
      readiness.ready = false;
      webSockets.close(CLOSE_CODES.serviceRestart, "Service restart");
      sessions.closeAll(reason);
      await closeServer(server, config.shutdownGraceMs);
      logger.info("gateway.stopped", { reason });
    }
  };
}

function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server, graceMs: number) {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error("Gateway shutdown grace period exceeded"));
    }, graceMs);
    timeout.unref();
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  const config = loadConfig();
  const runtime = createGatewayRuntime(config);
  await runtime.listen();
  const stop = (signal: string) => {
    void runtime.shutdown(signal.toLowerCase()).then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "gateway.start.failed", reason: error instanceof Error ? error.message : "Startup failed" }));
    process.exit(1);
  });
}