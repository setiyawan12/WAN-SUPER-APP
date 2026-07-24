import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useEmailReveal } from "../../hooks/useEmailReveal";
import { usePolling } from "../../hooks/usePolling";
import { buildAuthIndexMap, resolveAccountLabel } from "./accounts";
import { applyActivityEvent, applyRecent, applyWeights, emptyGraph, pruneFirings } from "./graph";
import type { ActivityEvent, Firing, NeuronNode } from "./types";

export type AccountLabelFn = (authIndex: string | null | undefined) => string | null;

// Wires the pure graph core to the two live sources:
//   A (instant) — window.wan.onEvent("activity") from the proxy / in-app chat
//   B (near-live) — polled recent[] from /api/usage/tokens (all providers)
// Plus a slow auth-files poll so firings can show which account served the hit.
// State lives in a ref (mutated in place by the pure reducers); a version bump
// triggers re-render. Nothing runs while `enabled` is false.
export function useNeuronGraph(enabled: boolean): {
  nodes: NeuronNode[];
  firings: Firing[];
  accountLabel: AccountLabelFn;
} {
  const stateRef = useRef(emptyGraph());
  const primedRef = useRef(false);
  const [, bump] = useState(0);
  const rerender = () => bump((n) => (n + 1) & 0xffff);

  // Path B: poll recent[] every 2.5s while the server is up.
  const { data } = usePolling(() => api.getUsageTokens(1), 2500, enabled);
  useEffect(() => {
    if (!data) return;
    const s = stateRef.current;
    applyWeights(s, data.byProviderModel);
    // First load primes the dedupe log without blinking the whole history.
    applyRecent(s, data.recent, Date.now(), { emitFirings: primedRef.current });
    primedRef.current = true;
    pruneFirings(s, Date.now());
    rerender();
  }, [data]);

  // Credential roster for auth_index → email. Slow poll is fine — accounts
  // rarely change mid-session; firings that arrive before the first roster
  // just omit the label until the map is ready.
  const { data: authData } = usePolling(api.getAuthFiles, 15000, enabled);
  const { revealed } = useEmailReveal();
  const authMap = useMemo(() => buildAuthIndexMap(authData?.files), [authData]);
  const accountLabel = useMemo<AccountLabelFn>(
    () => (authIndex) => resolveAccountLabel(authMap, authIndex, revealed),
    [authMap, revealed]
  );

  // Path A: instant activity events.
  useEffect(() => {
    if (!enabled) return;
    const off = window.wan.onEvent((ev) => {
      if (ev.type !== "activity") return;
      applyActivityEvent(stateRef.current, ev.payload as ActivityEvent);
      pruneFirings(stateRef.current, Date.now());
      rerender();
    });
    return off;
  }, [enabled]);

  // Steady tick so finished firings fade even when no new events arrive.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      pruneFirings(stateRef.current, Date.now());
      rerender();
    }, 1000);
    return () => clearInterval(id);
  }, [enabled]);

  // Reset when the server goes down so a restart starts clean.
  useEffect(() => {
    if (enabled) return;
    stateRef.current = emptyGraph();
    primedRef.current = false;
    rerender();
  }, [enabled]);

  const s = stateRef.current;
  return { nodes: Object.values(s.nodes), firings: s.firings, accountLabel };
}
