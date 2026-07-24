import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

// Desktop replacement for the extension's `vscode.workspace.getConfiguration`
// and the backend's /api/preferences. Plain JSON in userData -- no need for
// electron-store since the shape is tiny and stable (handbook Tahap 3, item 1).

/** Cowork write/run approval policy (Chat agent mode). */
export type CoworkPolicy = "readonly" | "safe" | "trusted" | "full";

/** Composer mode remembered across launches. */
export type ChatComposerMode = "ask" | "chat" | "agent";

export interface AppSettings {
  // Auto-start CLIProxyAPI when the app launches (eq. RENN_AUTO_START_SERVER).
  autoStartServer: boolean;
  // Whether VS Code's Custom Endpoint provider requires the proxy API key.
  // Off by default -- some VS Code builds never send an Authorization header
  // (see extension.ts doc comment), so the backend runs without proxy auth.
  requireApiKey: boolean;
  // Auto-sync model list into chatLanguageModels.json (start + interval + on change).
  autoSyncVsCode: boolean;
  // Launch the app at OS login.
  autoLaunch: boolean;
  // When auto-launched, start hidden to the tray (no window).
  startHidden: boolean;
  // Last window size/position, restored on next launch.
  windowBounds?: { width: number; height: number; x?: number; y?: number };
  // Cowork: how freely write/run tools auto-approve.
  // readonly = reject mutations; safe = always ask; trusted = auto non-danger; full = auto all.
  coworkPolicy: CoworkPolicy;
  // Cap tool executions per chat turn (0 = built-in defaults: 4 chat / 25 cowork).
  maxToolCalls: number;
  // Last Chat composer mode (Ask / Chat / Agent).
  chatComposerMode: ChatComposerMode;
}

const DEFAULTS: AppSettings = {
  autoStartServer: true,
  requireApiKey: false,
  autoSyncVsCode: true,
  autoLaunch: false,
  startHidden: false,
  coworkPolicy: "safe",
  maxToolCalls: 0,
  chatComposerMode: "chat",
};

const POLICIES = new Set<CoworkPolicy>(["readonly", "safe", "trusted", "full"]);
const COMPOSER_MODES = new Set<ChatComposerMode>(["ask", "chat", "agent"]);

/** Coerce on-disk JSON into a valid AppSettings (corrupt / partial files). */
function sanitize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const merged = { ...DEFAULTS, ...(raw ?? {}) };
  const policy = merged.coworkPolicy;
  const mode = merged.chatComposerMode;
  const max = Number(merged.maxToolCalls);
  return {
    ...merged,
    autoStartServer: !!merged.autoStartServer,
    requireApiKey: !!merged.requireApiKey,
    autoSyncVsCode: !!merged.autoSyncVsCode,
    autoLaunch: !!merged.autoLaunch,
    startHidden: !!merged.startHidden,
    coworkPolicy: POLICIES.has(policy as CoworkPolicy) ? (policy as CoworkPolicy) : DEFAULTS.coworkPolicy,
    maxToolCalls: Number.isFinite(max) ? Math.max(0, Math.min(50, max | 0)) : DEFAULTS.maxToolCalls,
    chatComposerMode: COMPOSER_MODES.has(mode as ChatComposerMode)
      ? (mode as ChatComposerMode)
      : DEFAULTS.chatComposerMode,
  };
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "wan-settings.json");
}

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (cache) return cache;
  let loaded: AppSettings;
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    loaded = sanitize(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    loaded = { ...DEFAULTS };
  }
  cache = loaded;
  return loaded;
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return getSettings()[key];
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
  const next = sanitize({ ...getSettings(), [key]: value });
  cache = next;
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // best-effort persistence; in-memory cache still updated
  }
  return next;
}
