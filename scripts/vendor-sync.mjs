/**
 * Sync vendor snapshots + working modules from sibling monorepo projects.
 * Run from wan-super-app/: node scripts/vendor-sync.mjs
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, cpSync } from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mono = path.dirname(root);

function rsync(src, dest, extra = "") {
  mkdirSync(path.dirname(dest), { recursive: true });
  const cmd = `rsync -a --delete --exclude node_modules --exclude dist --exclude out --exclude build --exclude graphify-out --exclude .git ${extra} "${src}/" "${dest}/"`;
  console.log(cmd);
  execSync(cmd, { stdio: "inherit" });
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
