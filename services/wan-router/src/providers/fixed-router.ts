import { GatewayError } from "../errors.js";
import type { NormalizedChatRequest } from "../inference/contracts.js";
import type { NormalizedChatEvent, ProviderAdapter, ProviderContext, ProviderModel } from "./types.js";

export interface FixedRouteCandidate {
  id: string;
  adapter: ProviderAdapter;
  models: readonly string[];
  priority: number;
}

export interface FixedRoutingProviderOptions {
  id?: string;
  candidates: readonly FixedRouteCandidate[];
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
  circuitObserver?: (candidateId: string, state: "closed" | "open") => void;
}

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}

function retryable(error: unknown): error is GatewayError {
  return error instanceof GatewayError
    && error.code !== "attempt_persistence_failed"
    && (error.status === 429 || error.status >= 500);
}

export class FixedRoutingProvider implements ProviderAdapter {
  readonly id: string;
  private readonly candidates: readonly FixedRouteCandidate[];
  private readonly circuits = new Map<string, CircuitState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly circuitObserver?: FixedRoutingProviderOptions["circuitObserver"];

  constructor(options: FixedRoutingProviderOptions) {
    if (!options.candidates.length) throw new Error("Fixed routing requires at least one candidate.");
    const ids = new Set<string>();
    for (const candidate of options.candidates) {
      if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(candidate.id)) throw new Error("Route candidate ID is invalid.");
      if (ids.has(candidate.id)) throw new Error(`Duplicate route candidate: ${candidate.id}`);
      if (!candidate.models.length || candidate.models.some((model) => !model.trim())) {
        throw new Error(`Route candidate ${candidate.id} requires model IDs.`);
      }
      if (!Number.isFinite(candidate.priority)) throw new Error(`Route candidate ${candidate.id} priority is invalid.`);
      ids.add(candidate.id);
      this.circuits.set(candidate.id, { consecutiveFailures: 0, openUntil: 0 });
      options.circuitObserver?.(candidate.id, "closed");
    }
    const failureThreshold = options.failureThreshold ?? 3;
    const cooldownMs = options.cooldownMs ?? 30_000;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 100) {
      throw new Error("Circuit failure threshold must be between 1 and 100.");
    }
    if (!Number.isInteger(cooldownMs) || cooldownMs < 1_000 || cooldownMs > 3_600_000) {
      throw new Error("Circuit cooldown must be between 1000 and 3600000 milliseconds.");
    }

    this.id = options.id ?? "fixed-router";
    this.candidates = [...options.candidates].sort((left, right) => (
      right.priority - left.priority || left.id.localeCompare(right.id)
    ));
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = options.now ?? Date.now;
    this.circuitObserver = options.circuitObserver;
  }

  async listModels(): Promise<ProviderModel[]> {
    const result = new Map<string, ProviderModel>();
    for (const candidate of this.candidates) {
      const allowed = new Set(candidate.models);
      for (const model of await candidate.adapter.listModels()) {
        if ((allowed.has("*") || allowed.has(model.id)) && model.status !== "disabled" && !result.has(model.id)) {
          result.set(model.id, { ...model, capabilities: { ...model.capabilities } });
        }
      }
    }
    return [...result.values()];
  }

  chat(request: NormalizedChatRequest, context: ProviderContext): AsyncIterable<NormalizedChatEvent> {
    const eligible = this.candidates.filter((candidate) => (
      candidate.models.includes("*") || candidate.models.includes(request.model)
    ));
    if (!eligible.length) {
      throw new GatewayError(404, "invalid_request_error", "model_not_found", `Model ${request.model} was not found.`);
    }
    return this.route(eligible, request, context);
  }

  private async *route(
    eligible: readonly FixedRouteCandidate[],
    request: NormalizedChatRequest,
    context: ProviderContext,
  ): AsyncIterable<NormalizedChatEvent> {
    let attempted = 0;
    let transientFailures = 0;
    let lastTransientError: GatewayError | undefined;
    for (const candidate of eligible) {
      const circuit = this.circuits.get(candidate.id)!;
      if (circuit.openUntil > this.now()) continue;
      if (circuit.openUntil > 0) this.circuitObserver?.(candidate.id, "closed");
      attempted += 1;
      let iterator: AsyncIterator<NormalizedChatEvent> | undefined;
      let emitted = false;
      try {
        iterator = candidate.adapter.chat(request, context)[Symbol.asyncIterator]();
        let current = await iterator.next();
        if (current.done) {
          throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned no completion events.");
        }
        while (!current.done) {
          if (current.value.type !== "ready") emitted = true;
          yield current.value;
          current = await iterator.next();
        }
        this.recordSuccess(candidate.id);
        return;
      } catch (error) {
        if (context.signal.aborted) {
          throw new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request.");
        }
        if (!retryable(error)) throw error;
        this.recordFailure(candidate.id);
        if (emitted) throw error;
        transientFailures += 1;
        lastTransientError = error;
      } finally {
        await iterator?.return?.();
      }
    }

    if (!attempted) {
      throw new GatewayError(503, "api_error", "provider_endpoints_unavailable", "All eligible provider endpoints have an open circuit.");
    }
    if (transientFailures) {
      if (attempted === 1 && lastTransientError) throw lastTransientError;
      throw new GatewayError(502, "api_error", "all_provider_attempts_failed", "All eligible provider attempts failed before producing output.");
    }
    throw new GatewayError(503, "api_error", "provider_endpoints_unavailable", "No eligible provider endpoint is available.");
  }

  private recordSuccess(candidateId: string): void {
    const circuit = this.circuits.get(candidateId)!;
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
    this.circuitObserver?.(candidateId, "closed");
  }

  private recordFailure(candidateId: string): void {
    const circuit = this.circuits.get(candidateId)!;
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= this.failureThreshold) {
      circuit.openUntil = this.now() + this.cooldownMs;
      this.circuitObserver?.(candidateId, "open");
    }
  }
}