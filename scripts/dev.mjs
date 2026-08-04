// Dev: build main + assets, Vite renderers, launch Electron.
import { spawn, execSync } from "node:child_process";
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

execSync("npm run build:main && npm run build:ssh && npm run copy:assets", {
  stdio: "inherit",
  cwd: root,
});

const hub = await createServer({
  configFile: path.join(root, "vite.config.hub.ts"),
});
await hub.listen();
const hubUrl = hub.resolvedUrls?.local?.[0];
if (!hubUrl) throw new Error("Hub Vite server has no URL");

const clip = await createServer({
  configFile: path.join(root, "vite.config.cliproxy.ts"),
});
await clip.listen();
const clipUrl = clip.resolvedUrls?.local?.[0];
if (!clipUrl) throw new Error("Cliproxy Vite server has no URL");

const ssh = await createServer({
  configFile: path.join(root, "vite.config.ssh.ts"),
});
await ssh.listen();
const sshUrl = ssh.resolvedUrls?.local?.[0];
if (!sshUrl) throw new Error("SSH Vite server has no URL");

console.log(`[dev] hub ${hubUrl}`);
console.log(`[dev] cliproxy renderer ${clipUrl}`);
console.log(`[dev] ssh renderer ${sshUrl}`);

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL_HUB: hubUrl,
    VITE_DEV_SERVER_URL: clipUrl,
    VITE_DEV_SERVER_URL_SSH: sshUrl,
  },
});

child.on("close", async () => {
  await hub.close();
  await clip.close();
  await ssh.close();
  process.exit(0);
});
