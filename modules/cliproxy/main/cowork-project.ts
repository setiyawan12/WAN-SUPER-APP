import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { CoworkProject } from "./cowork-types.js";
// Electron is loaded only in pickCoworkProject so pure unit tests can import
// path-guard / snapshot helpers without requiring the Electron runtime.

// Cowork project root + path guard (HANDBOOK §4). Global for the app session —
// tools only run when a root is set. Path escape via `..` or symlink is blocked
// by resolveInside() (Jebakan #1).

let current: CoworkProject | null = null;
let lastCheckpoint: string | null = null; // git rev or backup id

export function getCoworkProject(): CoworkProject | null {
  return current;
}

/** Session state for UI: project + whether Undo has a restore point. */
export function getCoworkState(): {
  project: CoworkProject | null;
  canUndo: boolean;
  lastCheckpoint: string | null;
} {
  return {
    project: current,
    canUndo: !!current && !!lastCheckpoint,
    lastCheckpoint,
  };
}

export function getRoot(): string | null {
  return current?.root ?? null;
}

export function clearCoworkProject(): void {
  current = null;
  lastCheckpoint = null;
}

export async function pickCoworkProject(
  win: import("electron").BrowserWindow | null
): Promise<CoworkProject | null> {
  const { dialog } = await import("electron");
  const opts: Electron.OpenDialogOptions = {
    title: "Open project folder for Cowork",
    properties: ["openDirectory"],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  return setCoworkRoot(res.filePaths[0]);
}

export function setCoworkRoot(folder: string): CoworkProject {
  const root = fs.realpathSync(folder);
  current = {
    id: randomUUID(),
    name: path.basename(root),
    root,
    git: fs.existsSync(path.join(root, ".git")),
    addedAt: Date.now(),
  };
  lastCheckpoint = null;
  return current;
}

/**
 * Resolve a project-relative path and reject anything that escapes the root
 * (including via symlink). Non-existent paths are allowed (create/write) as long
 * as their resolved absolute form still sits under root.
 */
export function resolveInside(rel: string): string {
  if (!current) throw new Error("No Cowork project selected");
  const rootReal = fs.realpathSync(current.root);
  // Reject absolute inputs that aren't already under root — still resolve them
  // against root for relative paths.
  const candidate = path.isAbsolute(rel) ? rel : path.resolve(rootReal, rel);
  // Walk up existing parents so realpath works for files that don't exist yet.
  let probe = candidate;
  let realProbe = probe;
  while (true) {
    try {
      realProbe = fs.realpathSync(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  // Reconstruct the real absolute path for a not-yet-created leaf.
  const tail = path.relative(probe, candidate);
  const real = tail && tail !== "" ? path.resolve(realProbe, tail) : realProbe;
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`Path escapes project root: ${rel}`);
  }
  return real;
}

/** Project-relative path for display (posix-ish separators). */
export function toRel(abs: string): string {
  if (!current) return abs;
  const rel = path.relative(current.root, abs);
  return rel.split(path.sep).join("/") || ".";
}

// ── Secrets / ignore helpers ────────────────────────────────────────────────

const SECRET_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
]);

export function isSecretPath(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  if (SECRET_NAMES.has(base)) return true;
  if (base.startsWith(".env.")) return true; // .env.staging, .env.production.local, …
  if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12")) return true;
  if (base.includes("secret") && (base.endsWith(".json") || base.endsWith(".yml") || base.endsWith(".yaml"))) return true;
  return false;
}

const DEFAULT_IGNORE = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "coverage", ".wan"]);

export function shouldSkipDir(name: string): boolean {
  return DEFAULT_IGNORE.has(name) || name.startsWith(".");
}

/** Shallow tree for context injection (depth 2–3). */
export function buildTree(rel = ".", depth = 2): string {
  if (!current) return "(no project)";
  const lines: string[] = [];
  const walk = (dirRel: string, d: number, prefix: string) => {
    if (d < 0) return;
    let abs: string;
    try {
      abs = resolveInside(dirRel);
    } catch {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (shouldSkipDir(ent.name) && ent.isDirectory()) continue;
      if (ent.name.startsWith(".") && ent.name !== ".gitignore") continue;
      const childRel = dirRel === "." ? ent.name : `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) {
        lines.push(`${prefix}${ent.name}/`);
        if (d > 0) walk(childRel, d - 1, prefix + "  ");
      } else {
        lines.push(`${prefix}${ent.name}`);
      }
    }
  };
  lines.push(`${current.name}/`);
  walk(rel, depth, "  ");
  return lines.join("\n");
}

// ── Git checkpoint / undo ───────────────────────────────────────────────────

function runGit(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    child.on("error", (err) => resolve({ code: 1, out: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

// ── Non-git file snapshot (C5) ──────────────────────────────────────────────
// Caps keep backups bounded; secrets & ignored dirs are skipped.

const BACKUP_MAX_FILE = 512 * 1024;
const BACKUP_MAX_TOTAL = 20 * 1024 * 1024;
const BACKUP_MAX_FILES = 400;

interface SnapshotManifest {
  id: string;
  createdAt: number;
  files: string[]; // project-relative posix paths
}

function snapshotWalk(root: string): { rel: string; abs: string; size: number }[] {
  const out: { rel: string; abs: string; size: number }[] = [];
  let total = 0;
  const walk = (dir: string) => {
    if (out.length >= BACKUP_MAX_FILES || total >= BACKUP_MAX_TOTAL) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= BACKUP_MAX_FILES || total >= BACKUP_MAX_TOTAL) return;
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name)) continue;
        walk(path.join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isSecretPath(rel)) continue;
      if (rel.startsWith(".wan/")) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > BACKUP_MAX_FILE) continue;
      if (total + st.size > BACKUP_MAX_TOTAL) continue;
      // skip obvious binaries by extension
      if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|wasm|dmg|exe|dll|so|dylib)$/i.test(rel)) {
        continue;
      }
      out.push({ rel, abs, size: st.size });
      total += st.size;
    }
  };
  walk(root);
  return out;
}

async function createFileSnapshot(): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!current) return { ok: false, error: "No project selected" };
  const id = `snap-${Date.now()}`;
  const destRoot = path.join(current.root, ".wan", "backups", id);
  fs.mkdirSync(destRoot, { recursive: true });
  const files = snapshotWalk(current.root);
  const kept: string[] = [];
  for (const f of files) {
    const dest = path.join(destRoot, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(f.abs, dest);
      kept.push(f.rel);
    } catch {
      /* skip unreadable */
    }
  }
  const manifest: SnapshotManifest = { id, createdAt: Date.now(), files: kept };
  fs.writeFileSync(path.join(destRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  lastCheckpoint = id;
  return {
    ok: true,
    id,
    error: kept.length
      ? undefined
      : "Snapshot created but no eligible files were copied (all ignored/too large?).",
  };
}

async function restoreFileSnapshot(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!current) return { ok: false, error: "No project selected" };
  const destRoot = path.join(current.root, ".wan", "backups", id);
  const manPath = path.join(destRoot, "manifest.json");
  if (!fs.existsSync(manPath)) return { ok: false, error: `Snapshot not found: ${id}` };
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manPath, "utf8")) as SnapshotManifest;
  } catch {
    return { ok: false, error: "Corrupt snapshot manifest" };
  }
  for (const rel of manifest.files) {
    const src = path.join(destRoot, rel);
    if (!fs.existsSync(src)) continue;
    let abs: string;
    try {
      abs = resolveInside(rel);
    } catch {
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      fs.copyFileSync(src, abs);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true };
}

export async function createCheckpoint(): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!current) return { ok: false, error: "No project selected" };
  if (!current.git) {
    return createFileSnapshot();
  }
  const cwd = current.root;
  // Stage everything and commit so undo can hard-reset to this rev.
  await runGit(["add", "-A"], cwd);
  const msg = `wan: checkpoint ${new Date().toISOString()}`;
  const commit = await runGit(["commit", "--allow-empty", "-m", msg], cwd);
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.out)) {
    return { ok: false, error: commit.out.trim() || "git commit failed" };
  }
  const rev = await runGit(["rev-parse", "HEAD"], cwd);
  if (rev.code !== 0) return { ok: false, error: rev.out.trim() || "rev-parse failed" };
  lastCheckpoint = rev.out.trim();
  return { ok: true, id: lastCheckpoint };
}

export async function undoCheckpoint(): Promise<{ ok: boolean; error?: string }> {
  if (!current) return { ok: false, error: "No project selected" };
  if (!lastCheckpoint) return { ok: false, error: "No checkpoint to restore" };
  if (lastCheckpoint.startsWith("snap-")) {
    return restoreFileSnapshot(lastCheckpoint);
  }
  if (!current.git) {
    return { ok: false, error: "No git checkpoint to restore" };
  }
  const res = await runGit(["reset", "--hard", lastCheckpoint], current.root);
  if (res.code !== 0) return { ok: false, error: res.out.trim() || "git reset failed" };
  return { ok: true };
}

export function getLastCheckpoint(): string | null {
  return lastCheckpoint;
}
