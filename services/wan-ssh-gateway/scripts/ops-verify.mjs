import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const caddy = await readFile(new URL("../docker/Caddyfile.production.example", import.meta.url), "utf8");
const alerts = await readFile(new URL("../observability/alerts.yml", import.meta.url), "utf8");
const runbook = await readFile(new URL("../docs/OPS-SSH-01.md", import.meta.url), "utf8");

assert.match(caddy, /ssh\.example\.com/);
assert.match(caddy, /wss:\/\/ssh\.example\.com/);
assert.match(caddy, /header_up X-Forwarded-For \{remote_host\}/);
assert.doesNotMatch(caddy, /handle \/metrics/);
assert.match(alerts, /wan_ssh_process_ready == 0/);
assert.match(alerts, /wan_ssh_ws_auth_total\{result="failure"\}/);
assert.match(alerts, /wan_ssh_sessions_active \/ wan_ssh_sessions_limit/);
assert.match(runbook, /previous known-good image digest/i);
assert.match(runbook, /Credential exposure/);
assert.match(runbook, /WebSockets with `1012`/);

console.log("OPS-SSH-01 repository artifacts verified");
