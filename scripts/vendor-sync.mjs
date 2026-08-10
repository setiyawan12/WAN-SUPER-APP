/**
 * Sync vendor snapshots + working modules from sibling monorepo projects.
 * Run from wan-super-app/: node scripts/vendor-sync.mjs
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, cpSync, readFileSync, writeFileSync } from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mono = path.dirname(root);

function rsync(src, dest, extra = "") {
  mkdirSync(path.dirname(dest), { recursive: true });
  const cmd = `rsync -a --delete --exclude node_modules --exclude dist --exclude out --exclude build --exclude graphify-out --exclude .git ${extra} "${src}/" "${dest}/"`;
  console.log(cmd);
  execSync(cmd, { stdio: "inherit" });
}

function replaceRequired(file, original, replacement) {
  const text = readFileSync(file, "utf8");
  if (text.includes(replacement)) return;
  if (!text.includes(original)) {
    throw new Error(`Cannot re-apply required Super App patch in ${file}`);
  }
  writeFileSync(file, text.replace(original, replacement), "utf8");
}

function enforceCliproxyLocalSecurity() {
  const backend = path.join(root, "modules/cliproxy/main/backend");
  replaceRequired(
    path.join(backend, "index.js"),
    `app.get("/", (req, res) => res.json({ name: "renn-copilot-backend", status: "ok" }));\n\napp.listen(settings.port, () => {`,
    `app.get("/", (req, res) => res.json({ name: "renn-copilot-backend", status: "ok" }));\n\napp.use((err, _req, res, next) => {\n  if (err instanceof Error && err.message === "Not allowed by CORS") {\n    res.status(403).json({ error: "Origin not allowed" });\n    return;\n  }\n  next(err);\n});\n\nexport const backendServer = app.listen(settings.port, "127.0.0.1", () => {`,
  );
  replaceRequired(
    path.join(backend, "usage-poller.js"),
    `  setInterval(() => drainOnce().catch(() => {}), POLL_INTERVAL_MS);`,
    `  const timer = setInterval(() => drainOnce().catch(() => {}), POLL_INTERVAL_MS);\n  timer.unref?.();`,
  );
  console.log("[vendor-sync] re-applied Cliproxy loopback/CORS/runtime cleanup patch");
}

const clipSrc = path.join(mono, "wan-cliproxyapi");
const netSrc = path.join(mono, "wan-net");

if (!existsSync(clipSrc) || !existsSync(netSrc)) {
  console.error("Expected sibling repos wan-cliproxyapi and wan-net next to wan-super-app");
  process.exit(1);
}

rsync(clipSrc, path.join(root, "vendor/wan-cliproxyapi"));
rsync(netSrc, path.join(root, "vendor/wan-net"));

// Working modules (preserve adapter/ patches by only syncing source trees)
rsync(path.join(clipSrc, "src/main"), path.join(root, "modules/cliproxy/main"), "--exclude super-boot.ts");
enforceCliproxyLocalSecurity();
// Re-apply super-boot is local — not in vendor. Don't delete adapter.
rsync(path.join(clipSrc, "src/preload"), path.join(root, "modules/cliproxy/preload"));
rsync(path.join(clipSrc, "src/renderer"), path.join(root, "modules/cliproxy/renderer"));

rsync(path.join(netSrc, "lib"), path.join(root, "modules/net/lib"));
// electron: sync but keep main.js embed patches — use copy without --delete of adapter
execSync(
  `rsync -a --exclude node_modules "${path.join(netSrc, "electron")}/" "${path.join(root, "modules/net/electron")}/"`,
  { stdio: "inherit" }
);

// WANN SSH (sibling): build bundle via electron-vite lalu vendor hasilnya.
// Berbeda dari cliproxy/net (source verbatim) — ssh dipaketkan dulu oleh toolchain-nya.
const sshSrc = path.join(mono, "wann-ssh");
if (existsSync(sshSrc)) {
  execSync("npm run build", { cwd: sshSrc, stdio: "inherit" });
  for (const part of ["main", "preload", "renderer"]) {
    const from = path.join(sshSrc, "out", part);
    const to = path.join(root, "modules/ssh", part);
    mkdirSync(to, { recursive: true });
    // Hanya sub-folder hasil build yang di-sync; adapter/ & package.json lokal (patch
    // Super App) TIDAK disentuh.
    execSync(`rsync -a --delete "${from}/" "${to}/"`, { stdio: "inherit" });
  }
} else {
  console.warn("[vendor-sync] sibling wann-ssh tidak ditemukan — lewati modul ssh");
}

const handbook = path.join(mono, "HANDBOOK-WAN-SUPER-APP.md");
if (existsSync(handbook)) {
  cpSync(handbook, path.join(root, "HANDBOOK-WAN-SUPER-APP.md"));
}

console.log("[vendor-sync] done. Re-apply Super App patches if electron/main.js was overwritten.");
