import express from "express";
import type { GatewayConfig } from "./config.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { GatewayMetrics } from "./observability/metrics.js";

export interface ReadinessState {
  ready: boolean;
}

export function createApp(config: GatewayConfig, readiness: ReadinessState, metrics?: GatewayMetrics) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, service: "wan-ssh-gateway", version: "0.1.0", protocolVersion: PROTOCOL_VERSION });
  });
  app.get("/readyz", (_request, response) => {
    response.status(readiness.ready ? 200 : 503).json({ ok: readiness.ready, service: "wan-ssh-gateway", protocolVersion: PROTOCOL_VERSION });
  });
  app.get("/runtime-config.json", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ service: "wan-ssh-gateway", protocolVersion: PROTOCOL_VERSION, authMode: config.authMode });
  });
  app.get("/metrics", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.type("text/plain; version=0.0.4; charset=utf-8").send(metrics?.render() ?? "");
  });
  app.use((_request, response) => response.status(404).json({ ok: false }));
  return app;
}