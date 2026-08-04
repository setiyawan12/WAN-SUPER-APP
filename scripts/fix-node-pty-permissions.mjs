import { chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const prebuilds = path.join(root, "node_modules", "node-pty", "prebuilds");

if (existsSync(prebuilds)) {
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("darwin-")) continue;
    const helper = path.join(prebuilds, entry.name, "spawn-helper");
    if (existsSync(helper)) await chmod(helper, 0o755);
  }
}