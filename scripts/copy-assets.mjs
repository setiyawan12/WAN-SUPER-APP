/**
 * Copy runtime assets that tsc/vite don't emit into out/.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function copyDir(from, to) {
  if (!existsSync(from)) {
    console.warn(`[copy-assets] skip missing: ${from}`);
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: true });
}

async function copyFile(from, to) {
  if (!existsSync(from)) {
    console.warn(`[copy-assets] skip missing file: ${from}`);
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { force: true });
}

// Hub preload + icons next to main
await mkdir(path.join(root, "out/main"), { recursive: true });
await mkdir(path.join(root, "out/preload"), { recursive: true });
await copyFile(path.join(root, "src/preload/hub.cjs"), path.join(root, "out/preload/hub.cjs"));
for (const name of ["icon.png", "tray.png"]) {
  await copyFile(path.join(root, "build", name), path.join(root, "out/main", name));
}

// Cliproxy: backend (verbatim JS), preload, tools if any under main
await copyDir(
  path.join(root, "modules/cliproxy/main/backend"),
  path.join(root, "out/modules/cliproxy/main/backend")
);
await copyDir(
  path.join(root, "modules/cliproxy/preload"),
  path.join(root, "out/modules/cliproxy/preload")
);
// main/tools may contain non-TS assets
const toolsSrc = path.join(root, "modules/cliproxy/main/tools");
if (existsSync(toolsSrc)) {
  // Only copy non-.ts runtime files if present; compiled tools come from tsc
  for (const ent of await readdir(toolsSrc, { withFileTypes: true })) {
    if (ent.isFile() && !ent.name.endsWith(".ts")) {
      await copyFile(
        path.join(toolsSrc, ent.name),
        path.join(root, "out/modules/cliproxy/main/tools", ent.name)
      );
    }
  }
}
const clipIcon = path.join(root, "build/icon.png");
await copyFile(clipIcon, path.join(root, "out/modules/cliproxy/main/icon.png"));

// Net module (CJS runtime tree + adapter + cloudflared optional)
// CJS boundary: root package.json is "type":"module", so without this marker
// Node would treat out/modules/net/**/*.js (which use require/module.exports)
// as ESM and crash. This package.json re-declares the net subtree as CommonJS.
await copyFile(
  path.join(root, "modules/net/package.json"),
  path.join(root, "out/modules/net/package.json")
);
await copyDir(path.join(root, "modules/net/lib"), path.join(root, "out/modules/net/lib"));
await copyDir(path.join(root, "modules/net/electron"), path.join(root, "out/modules/net/electron"));
await copyDir(path.join(root, "modules/net/adapter"), path.join(root, "out/modules/net/adapter"));
await copyDir(path.join(root, "modules/net/bin"), path.join(root, "out/modules/net/bin"));
const cf = path.join(root, "modules/net/cloudflared");
if (existsSync(cf)) {
  await copyFile(cf, path.join(root, "out/modules/net/cloudflared"));
}
const netIcon = path.join(root, "build/net-icon.png");
if (existsSync(netIcon)) {
  await copyFile(netIcon, path.join(root, "out/modules/net/electron/icon.png"));
} else if (existsSync(path.join(root, "modules/net/electron/icon.png"))) {
  // already in electron copy
}

// Optional adapter stub for cliproxy (if ever used)
const clipAdapter = path.join(root, "modules/cliproxy/adapter");
if (existsSync(clipAdapter)) {
  await copyDir(clipAdapter, path.join(root, "out/modules/cliproxy/adapter"));
}

// SSH module (CJS bundle: main + preload + renderer + adapter).
// Same CJS-boundary reason as net: root package.json is "type":"module", so the
// local package.json re-declares out/modules/ssh as CommonJS.
await copyFile(
  path.join(root, "modules/ssh/package.json"),
  path.join(root, "out/modules/ssh/package.json")
);
await copyDir(path.join(root, "modules/ssh/main"), path.join(root, "out/modules/ssh/main"));
await copyDir(path.join(root, "modules/ssh/preload"), path.join(root, "out/modules/ssh/preload"));
await copyDir(path.join(root, "modules/ssh/renderer"), path.join(root, "out/modules/ssh/renderer"));
await copyDir(path.join(root, "modules/ssh/adapter"), path.join(root, "out/modules/ssh/adapter"));

console.log("[copy-assets] hub preload, cliproxy backend/preload, net module, ssh module → out/");
