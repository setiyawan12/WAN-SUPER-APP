/** Ported from dashboard/lib/utils.ts (maskEmail, shortenPath). */
export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}

export function shortenPath(value: string, segments = 2): string {
  if (!value) return value;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return value;
  const sep = value.includes("\\") ? "\\" : "/";
  return `...${sep}${parts.slice(-segments).join(sep)}`;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(8)}${key.slice(-4)}`;
}

// Rough public per-token API rates, keyed by a substring match against a
// provider name -- used for cost *estimates* only (renn-copilot never sees
// real billing data), shared between the token-usage table and the
// per-credential Auth Files table on the Usage page.
export const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  claude: { input: 3, output: 15 },
  anthropic: { input: 3, output: 15 },
  gemini: { input: 1.25, output: 5 },
  antigravity: { input: 1.25, output: 5 },
  codex: { input: 2, output: 8 },
  chatgpt: { input: 2, output: 8 },
  openai: { input: 2, output: 8 },
};
const DEFAULT_PRICING = { input: 1, output: 3 };

export function ratesFor(provider: string) {
  const key = provider.toLowerCase();
  const match = Object.keys(PRICING_PER_MILLION).find((k) => key.includes(k));
  return match ? PRICING_PER_MILLION[match] : DEFAULT_PRICING;
}

// Rough token estimate for the composer meter (HANDBOOK §5, MVP heuristic).
// ~4 chars/token is close enough to warn before overflow without shipping a
// real tokenizer (js-tiktoken lands in M4/§7). Never precise — for guidance.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Approximate context windows keyed by model family (ModelEntry.family). These
// are UI hints only — CLIProxyAPI's /models doesn't expose real limits, so we
// don't invent a backend field for them.
const CONTEXT_WINDOW_BY_FAMILY: Record<string, number> = {
  claude: 200_000,
  gemini: 1_000_000,
  gpt: 128_000,
};
const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowForFamily(family: string | undefined): number {
  if (!family) return DEFAULT_CONTEXT_WINDOW;
  return CONTEXT_WINDOW_BY_FAMILY[family.toLowerCase()] ?? DEFAULT_CONTEXT_WINDOW;
}

export function formatUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 1 ? 4 : 2 });
}

export function formatNumber(n: number) {
  return n.toLocaleString("en-US");
}

/** Compact "18.59M" / "127.35K" style formatting, matching how token counts are shown in dense UI (e.g. quota bars). */
export function formatCompactNumber(n: number) {
  return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

export function parseRetryAfter(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const asNum = typeof value === "number" ? value : Number(value);
  if (!Number.isNaN(asNum) && asNum > 0) return asNum > 1e12 ? asNum : asNum * 1000;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatResetIn(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const diffMs = epochMs - Date.now();
  if (diffMs <= 0) return "should be available now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `~${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `~${hours}h${remMins ? ` ${remMins}m` : ""}`;
}

export function formatWindowLabel(seconds: number | null): string {
  if (!seconds) return "window";
  const hours = seconds / 3600;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function rateLimitColor(usedPercent: number | null): string {
  if (usedPercent === null) return "var(--vscode-testing-iconPassed, #4caf50)";
  if (usedPercent >= 90) return "var(--vscode-errorForeground)";
  if (usedPercent >= 70) return "var(--vscode-editorWarning-foreground, #cca700)";
  return "var(--vscode-testing-iconPassed, #4caf50)";
}
