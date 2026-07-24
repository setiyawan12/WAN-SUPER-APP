// Shared types for the "neuron activity" brain view. Kept dependency-free
// (no React/DOM) so the merge/dedupe logic in graph.ts stays unit-testable.

// Live event pushed from main over window.wan.onEvent("activity"). Mirrors the
// payload chat-proxy.js / chat-service.ts emit on the backend activity bus.
export interface ActivityEvent {
  phase: "start" | "end";
  reqId: string;
  model: string;
  provider?: string;
  ok?: boolean;
  latency_ms?: number;
  ts: number; // ms epoch
  source?: "proxy" | "chat";
}

// One neuron = one provider::model. Size ∝ cumulative requests; brightness in
// the render layer is derived from lastHitTs decay.
export interface NeuronNode {
  id: string; // `${provider}::${model}`
  provider: string;
  model: string;
  requests: number; // cumulative weight (from byProviderModel)
  lastHitTs: number | null; // ms epoch of last observed hit
  lastFailed: boolean;
  lastLatencyMs: number | null;
  // Last credential that served this model (from recent[] path B). Resolved to
  // an email/label at the UI layer via GET /auth-files.
  lastAuthIndex: string | null;
}

// A single "firing" pulse to animate. `live` distinguishes instant path A from
// near-live path B; `pending` marks an A-start still awaiting its end event.
export interface Firing {
  id: string;
  nodeId: string;
  reqId?: string; // from path A, used for dedupe
  startedAt: number; // ms epoch
  failed: boolean;
  latencyMs: number | null;
  live: boolean;
  pending: boolean;
  // Credential that served this request (path B /usage-queue). Path A starts
  // without it; when the same hit later appears in recent[], graph folds
  // auth_index into the existing live firing (see applyRecent coveredByA).
  authIndex: string | null;
  // "chat" = whole in-app turn (survives tool gaps). "proxy" = one HTTP hop.
  source?: "proxy" | "chat";
  // Soft-settle clock: hop ended but sticky bridge keeps pending alive so LIVE
  // does not blink off between tool rounds (see STICKY_BRIDGE_MS in graph.ts).
  softEndedAt?: number | null;
}

export interface GraphState {
  nodes: Record<string, NeuronNode>;
  firings: Firing[];
  seenReqIds: string[]; // bounded dedupe log for path A
  seenRecent: string[]; // bounded dedupe log for path B record hashes
}
