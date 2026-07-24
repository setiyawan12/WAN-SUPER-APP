import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipboard, Notification, shell } from "electron";
import { backendUrl } from "./config.js";
import { getSetting } from "./app-settings.js";
import { broadcast } from "./events.js";

// ---------------------------------------------------------------------------
// Port of the extension's VS Code integration (extension.ts ~lines 465-557),
// with the two changes the handbook (Tahap 7) calls out because we run
// OUTSIDE VS Code:
//   1. No vscode.env.appName -> scan every VS Code variant on disk.
//   2. No vscode.env.clipboard / window.showInformationMessage -> Electron
//      clipboard + OS Notification.
// The write rules in writeProviderEntry are ported VERBATIM (they encode hard
// debugging lessons -- handbook Jebakan #3 / §10.2).
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "WAN X RENN CLIProxyAPI";
const PROVIDER_VENDOR = "customendpoint";
const API_TYPE = "chat-completions";

// VS Code build variants and their config-dir folder names.
const VARIANTS = ["Code", "Code - Insiders", "Code - Exploration", "VSCodium"];

interface RemoteModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

interface ChatLanguageModelProvider {
  name: string;
  vendor: string;
  apiKey?: string;
  apiType?: string;
  models?: RemoteModelEntry[];
  [key: string]: unknown;
}

function configBase(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

/**
 * Every chatLanguageModels.json we should sync to. Only returns targets whose
 * User/ dir already exists, so we never create a config dir for a VS Code
 * variant the user doesn't have installed. Default profile only -- named
 * profiles under User/profiles/<id>/ aren't handled (same limitation as the
 * extension).
 */
export function detectVsCodeTargets(): string[] {
  return VARIANTS.map((v) => path.join(configBase(), v))
    .filter((dir) => fs.existsSync(path.join(dir, "User")))
    .map((dir) => path.join(dir, "User", "chatLanguageModels.json"));
}

export interface VsCodeState {
  targets: string[];
  variants: { path: string; hasEntry: boolean }[];
}

export function getVsCodeState(): VsCodeState {
  const targets = detectVsCodeTargets();
  const variants = targets.map((filePath) => {
    let hasEntry = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Array.isArray(parsed)) {
        hasEntry = parsed.some((p) => p.vendor === PROVIDER_VENDOR && p.name === PROVIDER_NAME);
      }
    } catch {
      hasEntry = false;
    }
    return { path: filePath, hasEntry };
  });
  return { targets, variants };
}

/**
 * Ported VERBATIM from extension.ts writeProviderEntry, per file.
 * MUST keep the "skip write if identical" rule: touching mtime (even with
 * byte-identical content) trips VS Code's file watcher, which resets the API
 * key the user pasted into Secret Storage -- forcing a re-paste every reload
 * (handbook Jebakan #3). `apiKey` here is NOT read by VS Code at request time
 * (Jebakan #9); it's metadata only. Omit the field entirely when empty.
 */
function writeProviderEntry(
  filePath: string,
  models: RemoteModelEntry[],
  apiKey: string
): { created: boolean; changed: boolean } {
  let providers: ChatLanguageModelProvider[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(parsed)) providers = parsed;
  } catch {
    providers = [];
  }

  const existingIndex = providers.findIndex(
    (p) => p.vendor === PROVIDER_VENDOR && p.name === PROVIDER_NAME
  );
  const entry: ChatLanguageModelProvider = {
    name: PROVIDER_NAME,
    vendor: PROVIDER_VENDOR,
    ...(apiKey ? { apiKey } : {}),
    apiType: API_TYPE,
    models,
  };

  const created = existingIndex === -1;
  const existingEntry = created ? null : providers[existingIndex];
  const unchanged = !created && JSON.stringify(existingEntry) === JSON.stringify(entry);
  if (unchanged) return { created: false, changed: false };

  if (created) providers.push(entry);
  else providers[existingIndex] = entry;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(providers, null, 2), "utf8");
  return { created, changed: true };
}

export interface SyncResult {
  ok: boolean;
  modelCount: number;
  changed: boolean;
  createdAny: boolean;
  targets: string[];
  error?: string;
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${backendUrl()}${pathname}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The desktop equivalent of the extension's syncModels(). Pulls the enabled
 * model list from the (in-process) backend and writes the Custom Endpoint
 * provider entry into every detected VS Code variant. On a real change, copies
 * the proxy API key to the clipboard and fires an OS notification -- mirroring
 * the extension's clipboard + "paste it in Manage Language Models" behaviour.
 */
export async function syncNow(notify = false): Promise<SyncResult> {
  const requireApiKey = getSetting("requireApiKey");
  try {
    const remote = await fetchJson<{ models: RemoteModelEntry[]; apiKey?: string }>(
      "/api/models/export"
    );

    // Flip CLIProxyAPI's proxy-auth requirement to match requireApiKey, so a
    // VS Code build that never sends an Authorization header still works.
    await fetchJson("/api/server/proxy-auth", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: requireApiKey }),
    }).catch(() => {
      /* non-fatal race; sync still proceeds */
    });

    const targets = detectVsCodeTargets();
    let changed = false;
    let createdAny = false;
    for (const filePath of targets) {
      const r = writeProviderEntry(
        filePath,
        remote.models,
        requireApiKey ? remote.apiKey ?? "" : ""
      );
      changed = changed || r.changed;
      createdAny = createdAny || r.created;
    }

    // Only touch the clipboard / notify when something actually changed --
    // exactly when VS Code will need the key re-pasted (extension.ts rationale).
    if (changed && requireApiKey && remote.apiKey) {
      clipboard.writeText(remote.apiKey);
    }

    if ((notify || changed) && Notification.isSupported()) {
      const body = !targets.length
        ? "No VS Code installation detected."
        : changed
          ? requireApiKey && remote.apiKey
            ? `Synced ${remote.models.length} model(s). API key copied — paste it in "Chat: Manage Language Models".`
            : `Synced ${remote.models.length} model(s) into ${targets.length} VS Code target(s).`
          : `Already up to date (${remote.models.length} model(s)).`;
      new Notification({ title: "WAN X RENN CLIProxyAPI", body }).show();
    }

    broadcast("sync", { modelCount: remote.models.length, changed, targets });
    return { ok: true, modelCount: remote.models.length, changed, createdAny, targets };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast("sync-error", { error: message });
    return { ok: false, modelCount: 0, changed: false, createdAny: false, targets: [], error: message };
  }
}

// --- Health monitoring (extension.ts refreshHealth, adapted for the tray) ---

export interface HealthEntry {
  label: string;
  provider: string;
  ok: boolean;
  disabled: boolean;
  next_retry_after: string | number | null;
}
export interface HealthSummary {
  available: number;
  unavailable: number;
  entries: HealthEntry[];
  reachable: boolean;
}

let lastHealth: HealthSummary = { available: 0, unavailable: 0, entries: [], reachable: false };
const healthListeners: ((h: HealthSummary) => void)[] = [];

export function onHealthChange(cb: (h: HealthSummary) => void): void {
  healthListeners.push(cb);
}
export function getLastHealth(): HealthSummary {
  return lastHealth;
}

export async function refreshHealth(): Promise<HealthSummary> {
  try {
    const usage = await fetchJson<{
      accounts: { label: string; provider: string; disabled: boolean; unavailable: boolean; next_retry_after: string | number | null }[];
      apiKeys: { provider: string; name: string | null; keyMasked: string }[];
    }>("/api/usage");

    const accountEntries: HealthEntry[] = (usage.accounts ?? []).map((a) => ({
      label: a.label,
      provider: a.provider,
      ok: !a.disabled && !a.unavailable,
      disabled: a.disabled,
      next_retry_after: a.next_retry_after,
    }));
    const apiKeyEntries: HealthEntry[] = (usage.apiKeys ?? []).map((k) => ({
      label: k.name || k.keyMasked,
      provider: k.provider,
      ok: true,
      disabled: false,
      next_retry_after: null,
    }));
    const entries = [...accountEntries, ...apiKeyEntries];
    const available = entries.filter((e) => e.ok).length;
    lastHealth = { available, unavailable: entries.length - available, entries, reachable: true };
  } catch {
    lastHealth = { ...lastHealth, reachable: false };
  }
  for (const cb of healthListeners) cb(lastHealth);
  broadcast("health", lastHealth);
  return lastHealth;
}

// --- Backend readiness + auto-sync scheduling -------------------------------

export async function waitForBackendReady(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${backendUrl()}/`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let syncDebounce: ReturnType<typeof setTimeout> | undefined;
/** Debounced sync -- called after the user toggles models in the dashboard. */
export function scheduleSync(): void {
  if (!getSetting("autoSyncVsCode")) return;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => void syncNow(false), 800);
}

let healthTimer: ReturnType<typeof setInterval> | undefined;
let syncTimer: ReturnType<typeof setInterval> | undefined;

/** Handbook Tahap 7.3: sync on start, on interval, and on model changes. */
export function startVsCodeAutoSync(): void {
  void waitForBackendReady().then(() => {
    void refreshHealth();
    if (getSetting("autoSyncVsCode")) void syncNow(false);
  });
  healthTimer = setInterval(() => void refreshHealth(), 30_000);
  syncTimer = setInterval(() => {
    if (getSetting("autoSyncVsCode")) void syncNow(false);
  }, 5 * 60_000);
}

export function stopVsCodeAutoSync(): void {
  clearInterval(healthTimer);
  clearInterval(syncTimer);
}

/** Copy the proxy API key to the clipboard (tray/menu action). */
export async function copyApiKey(): Promise<{ ok: boolean; error?: string }> {
  try {
    const remote = await fetchJson<{ apiKey?: string }>("/api/models/export");
    if (!remote.apiKey) return { ok: false, error: "Backend returned no API key yet." };
    clipboard.writeText(remote.apiKey);
    if (Notification.isSupported()) {
      new Notification({
        title: "WAN X RENN CLIProxyAPI",
        body: 'API key copied — paste it into "Chat: Manage Language Models".',
      }).show();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function openExternal(url: string): void {
  void shell.openExternal(url);
}
