import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;
const tscCommand = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const electronCommand = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const compiledTests = mkdtempSync(path.join(root, ".cliproxy-local-tests-"));

function run(label, command, args) {
  console.log(`\n[CLIPROXY-LOCAL] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run("Build Electron main and Cliproxy main", npmCommand, ["run", "build:main"]);
  run("Build Cliproxy renderer", npmCommand, ["run", "build:cliproxy-renderer"]);
  run("Copy Cliproxy runtime assets", npmCommand, ["run", "copy:assets"]);
  run("Backend routing and quota fixtures", nodeCommand, [
    "--test",
    "modules/cliproxy/main/model-combos.test.js",
    "modules/cliproxy/main/model-combos-proxy.test.js",
    "modules/cliproxy/main/quota-budget.test.js",
  ]);
  run("Compile desktop helper fixtures", tscCommand, [
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--lib", "ES2022,DOM",
    "--rootDir", "modules/cliproxy/main",
    "--outDir", compiledTests,
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
    "--resolveJsonModule",
    "--types", "node",
    "modules/cliproxy/main/cowork-project.test.ts",
    "modules/cliproxy/main/jetbrains-config.test.ts",
    "modules/cliproxy/main/tools/tools.test.ts",
  ]);
  run("Desktop Cowork, IDE, and tool fixtures", nodeCommand, [
    "--test",
    path.join(compiledTests, "cowork-project.test.js"),
    path.join(compiledTests, "jetbrains-config.test.js"),
    path.join(compiledTests, "tools/tools.test.js"),
  ]);
  run("Renderer stream transport fixtures", nodeCommand, [
    "--experimental-strip-types",
    "--test",
    "modules/cliproxy/renderer/transport/sse.test.ts",
  ]);
  run("Loopback backend smoke", nodeCommand, ["scripts/cliproxy-local-smoke.mjs"]);
  run("Hidden Electron preload and IPC smoke", electronCommand, ["scripts/cliproxy-local-electron-smoke.cjs"]);
  console.log("\n[CLIPROXY-LOCAL] Repository regression passed.");
} finally {
  rmSync(compiledTests, { recursive: true, force: true });
}