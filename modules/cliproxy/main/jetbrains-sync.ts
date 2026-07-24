import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Notification } from "electron";
import { backendUrl } from "./config.js";
import { broadcast } from "./events.js";
import {
  OPTIONS_FILE,
  keychainServiceName,
  parseServicesXml,
  serializeServicesXml,
  mergeServices,
  hasWanService,
  buildService,
  type JbService,
  type RemoteModelEntry,
} from "./jetbrains-config.js";

// ---------------------------------------------------------------------------
// "Jalur B": auto-inject the enabled models into the JetBrains ProxyAI plugin
// by writing its PersistentStateComponent file directly -- the JetBrains
// analogue of vscode-sync.ts writing chatLanguageModels.json. The fiddly pure
// logic (XML escaping, JSON-in-attribute round-trip, merge, id derivation)
// lives in jetbrains-config.ts and is unit-tested; this module wires it to the
// filesystem, the backend and the macOS keychain.
//
// Two hard facts about ProxyAI drive the design (verified against
// carlrobertoh/ProxyAI source, settings/service/custom/*):
//
//  1. ProxyAI serialises the WHOLE custom-services list as ONE Jackson JSON
//     string inside a single XML attribute -- see jetbrains-config.ts.
//  2. It refuses to send a request until a credential is stored in the IDE
//     PasswordSafe for that service id ("No API key found for custom service");
//     the Authorization header alone is not enough. On macOS the default
//     backend is the native Keychain, so we satisfy the gate from outside with
//     `security` (writeKeychainCredential) -- making the sync zero-touch. The
//     stored value is unused for auth (our header carries the literal key); it
//     only has to exist and be non-empty.
//
// Lifecycle caveat (unlike VS Code's live file watcher): JetBrains reads
// options/*.xml and credentials only at startup and REWRITES settings from
// memory on exit. So the IDE must be fully quit before syncing; we detect any
// running JetBrains IDE and warn.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// Vendor dirs that hold per-product JetBrains config. "Google" is where
// Android Studio lives; it also holds non-JetBrains apps, so detectTargets()
// only accepts AndroidStudio* products from it.
function vendorBases(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [path.join(appData, "JetBrains"), path.join(appData, "Google")];
  }
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [path.join(base, "JetBrains"), path.join(base, "Google")];
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [path.join(xdg, "JetBrains"), path.join(xdg, "Google")];
}

export interface JetBrainsTarget {
  product: string; // dir name, e.g. "IntelliJIdea2024.1" / "AndroidStudio2024.1"
  file: string; // .../<product>/options/CodeGPT_CustomServicesSettings.xml
  hasEntry: boolean; // already contains our wan- services
}

/**
 * Every installed JetBrains product profile we can sync to. A profile is
 * "installed" if its options/ dir exists (the IDE creates it on first run) --
 * the same "only touch what the user actually has" rule vscode-sync uses with
 * User/. Default profile only; named settings profiles aren't handled.
 */
export function detectJetBrainsTargets(): JetBrainsTarget[] {
  const targets: JetBrainsTarget[] = [];
  for (const base of vendorBases()) {
    const isGoogle = base.endsWith(`${path.sep}Google`);
    let names: string[] = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue; // vendor dir absent -> nothing installed under it
    }
    for (const product of names) {
      if (isGoogle && !/^AndroidStudio/i.test(product)) continue;
      const optionsDir = path.join(base, product, "options");
      if (!fs.existsSync(optionsDir)) continue;
      const file = path.join(optionsDir, OPTIONS_FILE);
      targets.push({ product, file, hasEntry: fileHasWanEntry(file) });
    }
  }
  return targets;
}

/**
 * Read the services already in a file. Returns [] for a missing/empty/own
 * file, or null when the file has content we don't recognise (caller must skip
 * it rather than clobber it).
 */
function readExistingServices(file: string): JbService[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no file -> start clean
  }
  const parsed = parseServicesXml(raw);
  return parsed.ok ? parsed.services : null;
}

function fileHasWanEntry(file: string): boolean {
  const existing = readExistingServices(file);
  return Array.isArray(existing) && hasWanService(existing);
}

async function writeKeychainCredential(serviceId: string, value: string): Promise<boolean> {
  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-a",
      "", // account: empty, matching how IntelliJ stores these (acct=<NULL>)
      "-s",
      keychainServiceName(serviceId),
      "-w",
      value,
      "-U", // update in place if the entry already exists
      "-D",
      "application password",
    ]);
    return true;
  } catch {
    return false;
  }
}

// Coarse best-effort scan for a running JetBrains IDE, used only to warn the
// user (writing while one is open gets overwritten when it exits). Specific
// launcher-name fragments to avoid matching unrelated "studio"/"idea" apps.
const JB_PROCESS_RE =
  /(idea|pycharm|webstorm|phpstorm|rubymine|clion|goland|datagrip|dataspell|rider|aqua|rustrover|jetbrains|androidstudio|android studio|studio\.sh|studio64)/i;

async function detectRunningJetBrains(): Promise<string[]> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("tasklist", ["/fo", "csv", "/nh"]);
      const names = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        if (JB_PROCESS_RE.test(line)) {
          const first = line.split(",")[0]?.replace(/^"|"$/g, "");
          if (first) names.add(first);
        }
      }
      return [...names];
    }
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "comm"]);
    const names = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (JB_PROCESS_RE.test(line)) names.add(path.basename(line.trim()));
    }
    return [...names];
  } catch {
    return []; // process listing unavailable -> just skip the warning
  }
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${backendUrl()}${pathname}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface JetBrainsTargetResult {
  product: string;
  file: string;
  status: "written" | "unchanged" | "error";
  error?: string;
}

export interface JetBrainsSyncResult {
  ok: boolean;
  modelCount: number;
  targets: JetBrainsTargetResult[];
  running: string[]; // running IDE process names (write may be clobbered)
  keychainSupported: boolean; // macOS native keychain -> credential gate auto-satisfied
  keychainWritten: number; // credentials stored so ProxyAI stops rejecting
  error?: string;
}

/**
 * Merge one Custom OpenAI service per enabled model into every detected
 * JetBrains product's ProxyAI config, preserving the user's own services and
 * skipping writes when nothing changed. The proxy key is embedded literally and
 * (on macOS) written into the keychain, so no manual paste is needed.
 */
export async function syncJetBrainsNow(notify = false): Promise<JetBrainsSyncResult> {
  try {
    const remote = await fetchJson<{ models: RemoteModelEntry[]; apiKey?: string }>(
      "/api/models/export"
    );
    // Embed the proxy key literally (local loopback). "wan" is a harmless
    // placeholder for when the proxy runs without auth and returns no key.
    const authValue = remote.apiKey || "wan";
    const desired = remote.models.map((m) => buildService(m, authValue));

    // Satisfy ProxyAI's mandatory per-service credential gate up front (macOS
    // keychain only). Keyed by our STABLE service ids, so this is idempotent.
    const keychainSupported = process.platform === "darwin";
    let keychainWritten = 0;
    if (keychainSupported) {
      for (const svc of desired) {
        if (await writeKeychainCredential(svc.id, authValue)) keychainWritten++;
      }
    }

    const targets = detectJetBrainsTargets();
    const running = await detectRunningJetBrains();
    const results: JetBrainsTargetResult[] = [];

    for (const target of targets) {
      const existing = readExistingServices(target.file);
      if (existing === null) {
        results.push({
          product: target.product,
          file: target.file,
          status: "error",
          error: "Existing config not recognised — left untouched",
        });
        continue;
      }
      const next = serializeServicesXml(mergeServices(existing, desired));

      let current: string | null = null;
      try {
        current = fs.readFileSync(target.file, "utf8");
      } catch {
        /* new file */
      }
      if (current === next) {
        results.push({ product: target.product, file: target.file, status: "unchanged" });
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(target.file), { recursive: true });
        fs.writeFileSync(target.file, next, "utf8");
        results.push({ product: target.product, file: target.file, status: "written" });
      } catch (err) {
        results.push({
          product: target.product,
          file: target.file,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const wrote = results.filter((r) => r.status === "written").length;
    // On macOS the credential gate is handled for us; elsewhere the user still
    // has to paste the key once per model in ProxyAI settings.
    const paste = keychainSupported ? "" : " Paste the API key once per model in ProxyAI settings.";
    if ((notify || wrote > 0) && Notification.isSupported()) {
      const body = !targets.length
        ? "No JetBrains IDE detected."
        : running.length
          ? `Wrote ${remote.models.length} model(s), but a JetBrains IDE is running — close it, sync again, then reopen so the change survives.`
          : wrote > 0
            ? `Injected ${remote.models.length} model(s) into ${wrote} JetBrains target(s). Reopen the IDE to pick them up.${paste}`
            : `Already up to date (${remote.models.length} model(s)).`;
      new Notification({ title: "WAN X RENN CLIProxyAPI", body }).show();
    }

    const result: JetBrainsSyncResult = {
      ok: true,
      modelCount: remote.models.length,
      targets: results,
      running,
      keychainSupported,
      keychainWritten,
    };
    broadcast("jetbrains-sync", result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    broadcast("jetbrains-sync-error", { error: message });
    return {
      ok: false,
      modelCount: 0,
      targets: [],
      running: [],
      keychainSupported: process.platform === "darwin",
      keychainWritten: 0,
      error: message,
    };
  }
}

export interface JetBrainsState {
  targets: JetBrainsTarget[];
  running: string[];
}

export async function getJetBrainsState(): Promise<JetBrainsState> {
  return { targets: detectJetBrainsTargets(), running: await detectRunningJetBrains() };
}
