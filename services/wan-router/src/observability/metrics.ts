import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type { TokenUsage } from "../inference/contracts.js";
import type { AuditAction, AuditOutcome } from "../data/repository.js";

export type GenerationMetricStatus = "succeeded" | "failed" | "cancelled";

export interface GatewayMetrics {
  readonly contentType: string;
  snapshot(): Promise<string>;
  observeHttpRequest(input: {
    method: string;
    path: string;
    status: number;
    durationMs: number;
  }): void;
  generationStarted(stream: boolean): void;
  generationFinalized(input: {
    status: GenerationMetricStatus;
    stream: boolean;
    durationMs: number;
    ttftMs?: number;
    usage?: TokenUsage;
    errorCode?: string;
  }): void;
  providerAttemptStarted(providerId: string): void;
  providerAttemptFinished(input: {
    providerId: string;
    status: GenerationMetricStatus;
    durationMs: number;
    ttftMs?: number;
    errorCode?: string;
  }): void;
  fallbackCompleted(succeeded: boolean): void;
  admissionRejected(errorCode: string): void;
  authenticationFailed(errorCode: string): void;
  auditRecorded(action: AuditAction, outcome: AuditOutcome): void;
  auditFailed(action: AuditAction): void;
  kmsOperationFailed(operation: "encrypt" | "decrypt", errorCode: string): void;
  setDatabasePool(input: { total: number; idle: number; waiting: number }): void;
  setDatabaseHealth(up: boolean): void;
  setStaleGenerations(count: number): void;
  setCircuitState(candidateId: string, state: "closed" | "open"): void;
}

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60];
const GENERATION_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const TTFT_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function routeLabel(path: string): string {
  if (path === "/healthz") return "/healthz";
  if (path === "/metrics") return "/metrics";
  if (path === "/v1/models") return "/v1/models";
  if (path === "/v1/chat/completions") return "/v1/chat/completions";
  if (path === "/api/keys") return "/api/keys";
  if (path === "/api/audit-events") return "/api/audit-events";
  if (/^\/api\/keys\/[^/]+$/.test(path)) return "/api/keys/:id";
  if (path === "/api/provider-credentials") return "/api/provider-credentials";
  if (/^\/api\/provider-credentials\/[^/]+\/verify$/.test(path)) {
    return "/api/provider-credentials/:id/verify";
  }
  if (/^\/api\/provider-credentials\/[^/]+$/.test(path)) return "/api/provider-credentials/:id";
  return "other";
}

function statusClass(status: number): string {
  if (status < 100 || status > 599) return "unknown";
  return `${Math.floor(status / 100)}xx`;
}

function boundedErrorCode(errorCode: string | undefined): string {
  if (!errorCode) return "none";
  return /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : "other";
}

function boundedProviderId(providerId: string): string {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(providerId) ? providerId : "other";
}

function boundedCandidateId(candidateId: string): string {
  return /^[a-z0-9][a-z0-9_-]{1,127}$/.test(candidateId) ? candidateId : "other";
}

export function createGatewayMetrics(): GatewayMetrics {
  const registry = new Registry();
  const httpRequests = new Counter({
    name: "wan_router_http_requests_total",
    help: "WAN Router HTTP requests by bounded route and status class.",
    labelNames: ["method", "route", "status_class"] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "wan_router_http_request_duration_seconds",
    help: "WAN Router HTTP request duration by bounded route.",
    labelNames: ["method", "route"] as const,
    buckets: HTTP_DURATION_BUCKETS,
    registers: [registry],
  });
  const generations = new Counter({
    name: "wan_router_generation_total",
    help: "Finalized WAN Router generations by status and stream mode.",
    labelNames: ["status", "stream"] as const,
    registers: [registry],
  });
  const generationDuration = new Histogram({
    name: "wan_router_generation_duration_seconds",
    help: "WAN Router generation duration by status and stream mode.",
    labelNames: ["status", "stream"] as const,
    buckets: GENERATION_DURATION_BUCKETS,
    registers: [registry],
  });
  const generationTtft = new Histogram({
    name: "wan_router_generation_ttft_seconds",
    help: "WAN Router time to first output event by stream mode.",
    labelNames: ["stream"] as const,
    buckets: TTFT_BUCKETS,
    registers: [registry],
  });
  const outputThroughput = new Histogram({
    name: "wan_router_output_tokens_per_second",
    help: "WAN Router completion-token throughput after the first output event.",
    labelNames: ["stream"] as const,
    buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160, 320, 640],
    registers: [registry],
  });
  const activeStreams = new Gauge({
    name: "wan_router_active_streams",
    help: "WAN Router generations currently active in streaming mode.",
    registers: [registry],
  });
  const tokens = new Counter({
    name: "wan_router_tokens_total",
    help: "WAN Router finalized token usage by dimension and estimation state.",
    labelNames: ["dimension", "estimated"] as const,
    registers: [registry],
  });
  const errors = new Counter({
    name: "wan_router_errors_total",
    help: "WAN Router generation failures by normalized bounded error code.",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  const providerAttempts = new Counter({
    name: "wan_router_provider_attempts_total",
    help: "WAN Router provider attempts by provider, final status, and bounded error code.",
    labelNames: ["provider", "status", "code"] as const,
    registers: [registry],
  });
  const providerAttemptDuration = new Histogram({
    name: "wan_router_provider_attempt_duration_seconds",
    help: "WAN Router provider attempt duration by provider and final status.",
    labelNames: ["provider", "status"] as const,
    buckets: GENERATION_DURATION_BUCKETS,
    registers: [registry],
  });
  const providerAttemptTtft = new Histogram({
    name: "wan_router_provider_attempt_ttft_seconds",
    help: "WAN Router provider attempt time to first output by provider.",
    labelNames: ["provider"] as const,
    buckets: TTFT_BUCKETS,
    registers: [registry],
  });
  const fallback = new Counter({
    name: "wan_router_fallback_total",
    help: "WAN Router requests that used more than one provider attempt.",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const admissionRejections = new Counter({
    name: "wan_router_admission_rejections_total",
    help: "WAN Router admission rejections by normalized bounded error code.",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  const authenticationFailures = new Counter({
    name: "wan_router_authentication_failures_total",
    help: "WAN Router authentication and authorization failures by bounded code.",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  const kmsFailures = new Counter({
    name: "wan_router_kms_failures_total",
    help: "WAN Router KMS operation failures by operation and bounded error code.",
    labelNames: ["operation", "code"] as const,
    registers: [registry],
  });
  const auditEvents = new Counter({
    name: "wan_router_audit_events_total",
    help: "WAN Router persisted audit events by bounded action and outcome.",
    labelNames: ["action", "outcome"] as const,
    registers: [registry],
  });
  const auditFailures = new Counter({
    name: "wan_router_audit_failures_total",
    help: "WAN Router audit persistence failures by bounded action.",
    labelNames: ["action"] as const,
    registers: [registry],
  });
  const databasePool = new Gauge({
    name: "wan_router_database_pool_connections",
    help: "WAN Router PostgreSQL pool connections by state.",
    labelNames: ["state"] as const,
    registers: [registry],
  });
  const dependencyUp = new Gauge({
    name: "wan_router_dependency_up",
    help: "WAN Router dependency health where 1 is up.",
    labelNames: ["dependency"] as const,
    registers: [registry],
  });
  const staleGenerations = new Gauge({
    name: "wan_router_stale_generations",
    help: "WAN Router pending generations older than the reconciliation cutoff.",
    registers: [registry],
  });
  const circuitState = new Gauge({
    name: "wan_router_circuit_open",
    help: "WAN Router circuit state by configured candidate, where 1 is open.",
    labelNames: ["candidate"] as const,
    registers: [registry],
  });

  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    for (const stream of ["false", "true"] as const) generations.labels(status, stream).inc(0);
  }
  activeStreams.set(0);
  for (const state of ["total", "idle", "waiting"] as const) databasePool.labels(state).set(0);
  dependencyUp.labels("postgres").set(0);
  staleGenerations.set(0);

  return {
    contentType: registry.contentType,
    snapshot: () => registry.metrics(),
    observeHttpRequest(input) {
      const method = input.method.toUpperCase().slice(0, 16);
      const route = routeLabel(input.path);
      httpRequests.labels(method, route, statusClass(input.status)).inc();
      httpDuration.labels(method, route).observe(Math.max(0, input.durationMs) / 1_000);
    },
    generationStarted(stream) {
      if (stream) activeStreams.inc();
    },
    generationFinalized(input) {
      const stream = String(input.stream);
      generations.labels(input.status, stream).inc();
      generationDuration.labels(input.status, stream).observe(Math.max(0, input.durationMs) / 1_000);
      if (input.ttftMs !== undefined) generationTtft.labels(stream).observe(Math.max(0, input.ttftMs) / 1_000);
      if (input.stream) activeStreams.dec();
      if (input.usage) {
        const estimated = String(input.usage.estimated === true);
        tokens.labels("prompt", estimated).inc(input.usage.prompt_tokens);
        tokens.labels("completion", estimated).inc(input.usage.completion_tokens);
        tokens.labels("total", estimated).inc(input.usage.total_tokens);
        const outputDurationSeconds = Math.max(0.001, (input.durationMs - (input.ttftMs ?? 0)) / 1_000);
        outputThroughput.labels(stream).observe(input.usage.completion_tokens / outputDurationSeconds);
      }
      if (input.status !== "succeeded") errors.labels(boundedErrorCode(input.errorCode)).inc();
    },
    providerAttemptStarted(providerId) {
      providerAttempts.labels(boundedProviderId(providerId), "started", "none").inc();
    },
    providerAttemptFinished(input) {
      const provider = boundedProviderId(input.providerId);
      providerAttempts.labels(provider, input.status, boundedErrorCode(input.errorCode)).inc();
      providerAttemptDuration.labels(provider, input.status).observe(Math.max(0, input.durationMs) / 1_000);
      if (input.ttftMs !== undefined) providerAttemptTtft.labels(provider).observe(Math.max(0, input.ttftMs) / 1_000);
    },
    fallbackCompleted(succeeded) {
      fallback.labels(succeeded ? "succeeded" : "failed").inc();
    },
    admissionRejected(errorCode) {
      admissionRejections.labels(boundedErrorCode(errorCode)).inc();
    },
    authenticationFailed(errorCode) {
      authenticationFailures.labels(boundedErrorCode(errorCode)).inc();
    },
    auditRecorded(action, outcome) {
      auditEvents.labels(action, outcome).inc();
    },
    auditFailed(action) {
      auditFailures.labels(action).inc();
    },
    kmsOperationFailed(operation, errorCode) {
      kmsFailures.labels(operation, boundedErrorCode(errorCode)).inc();
    },
    setDatabasePool(input) {
      databasePool.labels("total").set(Math.max(0, input.total));
      databasePool.labels("idle").set(Math.max(0, input.idle));
      databasePool.labels("waiting").set(Math.max(0, input.waiting));
    },
    setDatabaseHealth(up) {
      dependencyUp.labels("postgres").set(up ? 1 : 0);
    },
    setStaleGenerations(count) {
      staleGenerations.set(Math.max(0, count));
    },
    setCircuitState(candidateId, state) {
      circuitState.labels(boundedCandidateId(candidateId)).set(state === "open" ? 1 : 0);
    },
  };
}