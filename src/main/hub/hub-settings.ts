import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { ModuleId } from "../module-types.js";

export interface SuperAppSettings {
  lastModule: ModuleId | null;
  reopenLastModule: boolean;
  autoLaunch: boolean;
  startHidden: boolean;
  keepAliveWhenLeaving: boolean;
  /**
   * true  = open modules in their own BrowserWindow (default, current behavior)
   * false = replace hub window content with the selected module UI
   */
  openInNewWindow: boolean;
  theme: "aurora-dark";
  windowBoundsHub?: { width: number; height: number; x?: number; y?: number };
}

const DEFAULTS: SuperAppSettings = {
  lastModule: null,
  reopenLastModule: false,
  autoLaunch: false,
  startHidden: false,
  keepAliveWhenLeaving: true,
  openInNewWindow: true,
  theme: "aurora-dark",
};

function settingsPath(): string {
  return path.join(app.getPath("userData"), "super-app.json");
}

let cache: SuperAppSettings | null = null;

function sanitize(raw: Partial<SuperAppSettings> | null | undefined): SuperAppSettings {
  const merged = { ...DEFAULTS, ...(raw ?? {}) };
  const last = merged.lastModule;
  return {
    ...merged,
    lastModule: last === "cliproxy" || last === "net" || last === "ssh" ? last : null,
    reopenLastModule: !!merged.reopenLastModule,
    autoLaunch: !!merged.autoLaunch,
    startHidden: !!merged.startHidden,
    keepAliveWhenLeaving: merged.keepAliveWhenLeaving !== false,
    // default true when missing (older super-app.json)
    openInNewWindow: merged.openInNewWindow !== false,
    theme: "aurora-dark",
  };
}

export function getSettings(): SuperAppSettings {
  if (cache) return cache;
  try {
    const p = settingsPath();
    if (fs.existsSync(p)) {
      cache = sanitize(JSON.parse(fs.readFileSync(p, "utf8")));
      return cache;
    }
  } catch {
    /* fall through */
  }
  cache = { ...DEFAULTS };
  return cache;
}

export function setSetting<K extends keyof SuperAppSettings>(
  key: K,
  value: SuperAppSettings[K]
): SuperAppSettings {
  const next = sanitize({ ...getSettings(), [key]: value });
  cache = next;
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn("[super] save settings failed:", err);
  }
  return next;
}

export function setSettings(patch: Partial<SuperAppSettings>): SuperAppSettings {
  const next = sanitize({ ...getSettings(), ...patch });
  cache = next;
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn("[super] save settings failed:", err);
  }
  return next;
}
