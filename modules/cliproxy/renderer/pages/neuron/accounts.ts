// Resolve CLIProxyAPI auth_index → display label (email preferred) for the
// neuron activity feed. Pure helpers so unit tests can exercise masking /
// lookup without React or the network.

import type { AuthFileEntry } from "../../api/client";
import { maskEmail } from "../../lib/utils";

/** Build auth_index → email/label map from GET /auth-files entries. */
export function buildAuthIndexMap(files: AuthFileEntry[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!files) return map;
  for (const f of files) {
    if (f.auth_index == null || f.auth_index === "") continue;
    const label = (f.email || f.label || f.name || "").trim();
    if (!label) continue;
    map.set(String(f.auth_index), label);
  }
  return map;
}

/**
 * Look up a credential label and optionally mask email-shaped values.
 * Returns null when the index is missing or not in the map (caller omits the row).
 */
export function resolveAccountLabel(
  map: Map<string, string>,
  authIndex: string | null | undefined,
  revealed: boolean
): string | null {
  if (authIndex == null || authIndex === "") return null;
  const raw = map.get(String(authIndex));
  if (!raw) return null;
  if (revealed) return raw;
  // Only mask things that look like emails; leave bare file names alone.
  return raw.includes("@") ? maskEmail(raw) : raw;
}
