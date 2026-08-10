import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wan-cliproxy-local-")));
let backendServer;

process.env.PORT = "0";
process.env.CLIPROXY_HOME = home;
process.env.RENN_AUTO_START_SERVER = "0";

try {
  const backendUrl = pathToFileURL(path.join(root, "modules/cliproxy/main/backend/index.js"));
  const backend = await import(`${backendUrl.href}?smoke=${Date.now()}`);
  backendServer = backend.backendServer;
  if (!backendServer.listening) await once(backendServer, "listening");

  const address = backendServer.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  assert.equal(address.family, "IPv4");
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { name: "renn-copilot-backend", status: "ok" });

  const statusResponse = await fetch(`${origin}/api/server/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.running, false);
  assert.equal(status.binaryInstalled, false);
  assert.equal(status.configExists, true);
  assert.equal(fs.realpathSync(status.home), home);

  const stopResponse = await fetch(`${origin}/api/server/stop`, { method: "POST" });
  assert.equal(stopResponse.status, 200);
  assert.equal((await stopResponse.json()).running, false);

  const allowedOrigin = "vscode-webview://wan-local-smoke";
  const allowedResponse = await fetch(`${origin}/api/server/status`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(allowedResponse.status, 200);
  assert.equal(allowedResponse.headers.get("access-control-allow-origin"), allowedOrigin);

  const rejectedResponse = await fetch(`${origin}/api/server/status`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(rejectedResponse.status, 403);
  assert.equal(rejectedResponse.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await rejectedResponse.json(), { error: "Origin not allowed" });

  assert.ok(fs.existsSync(path.join(home, "config.yaml")));
  assert.ok(fs.existsSync(path.join(home, "auths")));
  console.log(`Cliproxy Local smoke passed (loopback ${address.address}:${address.port}, isolated storage, lifecycle, CORS).`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  if (backendServer?.listening) {
    await new Promise((resolve, reject) => {
      backendServer.close((error) => error ? reject(error) : resolve());
    });
  }
  fs.rmSync(home, { recursive: true, force: true });
}