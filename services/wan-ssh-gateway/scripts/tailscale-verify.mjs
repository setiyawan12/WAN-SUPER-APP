import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pemeriksa jalur egress Tailscale. Urutannya mengikuti urutan gagalnya di
 * produksi: allowlist gateway lebih dulu (karena `TARGET_DENIED` terjadi
 * sebelum socket dibuka), baru konektivitas TCP dari dalam container.
 */
const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stackScript = path.join(serviceDirectory, "scripts", "local-stack.mjs");
const environmentFile = path.join(serviceDirectory, ".env.local");

const [target, portArgument] = process.argv.slice(2);
const port = Number(portArgument ?? 22);

if (!target) {
  process.stderr.write("Usage: npm run ssh-web:tailscale-check -- <host-or-ip> [port]\n");
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  process.stderr.write(`Port is invalid: ${portArgument}\n`);
  process.exit(2);
}

const { ipMatchesCidrs } = await import(path.join(serviceDirectory, "dist/src/security/net.js")).catch(() => {
  process.stderr.write("dist is missing. Run `npm run ssh-gateway:build` first.\n");
  process.exit(2);
});

const allowCidrs = await resolveAllowCidrs();
const address = await resolveAddress(target);
const failures = [];

process.stdout.write(`Target      : ${target}${address === target ? "" : ` -> ${address}`}:${port}\n`);
process.stdout.write(`Allowlist   : ${allowCidrs.length ? allowCidrs.join(", ") : "(empty)"}\n`);

if (!allowCidrs.length) {
  failures.push("WAN_SSH_EGRESS_ALLOW_CIDRS is empty. Production refuses to start without it, and the Tailscale overlay defaults to 100.64.0.0/10.");
} else if (!ipMatchesCidrs(address, allowCidrs)) {
  failures.push(`${address} is outside the allowlist. Add its CIDR to WAN_SSH_EGRESS_ALLOW_CIDRS, e.g. 100.64.0.0/10 for a tailnet address or 10.8.0.0/24 for a subnet router.`);
} else {
  process.stdout.write("Allowlist   : PASS\n");
}

const probe = `require('net').connect({host:${JSON.stringify(address)},port:${port}})`
  + ".setTimeout(8000)"
  + ".on('connect',()=>{console.log('REACHABLE');process.exit(0)})"
  + ".on('timeout',()=>{console.log('TIMEOUT');process.exit(1)})"
  + ".on('error',(error)=>{console.log('ERROR '+error.code);process.exit(1)})";

const probeResult = await run("node", [stackScript, "exec", "-T", "gateway", "node", "-e", probe]);
if (probeResult.code === 0) process.stdout.write("TCP reach   : PASS (from inside the gateway container)\n");
else failures.push(`The gateway container cannot reach ${address}:${port}. Check that the tailscale sidecar is authenticated (\`npm run ssh-web:logs -- tailscale\`) and, for a subnet router, that its routes are approved in the admin console.`);

if (!failures.length) {
  process.stdout.write("\nOK — the gateway can open sessions to this target over Tailscale.\n");
  process.exit(0);
}
process.stderr.write("\nFAILED\n");
for (const failure of failures) process.stderr.write(`- ${failure}\n`);
process.exit(1);

async function resolveAllowCidrs() {
  const inline = process.env.WAN_SSH_EGRESS_ALLOW_CIDRS?.trim();
  const raw = inline || await fromEnvironmentFile();
  return (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

async function fromEnvironmentFile() {
  const contents = await readFile(environmentFile, "utf8").catch(() => "");
  const line = contents.split("\n").find((entry) => entry.startsWith("WAN_SSH_EGRESS_ALLOW_CIDRS="));
  return line?.slice("WAN_SSH_EGRESS_ALLOW_CIDRS=".length).trim();
}

async function resolveAddress(host) {
  if (isIP(host)) return host;
  const resolved = await lookup(host).catch(() => undefined);
  if (!resolved) {
    process.stderr.write(`${host} could not be resolved on this machine. MagicDNS names do not resolve inside the container either — use the tailnet IP.\n`);
    process.exit(1);
  }
  return resolved.address;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: serviceDirectory, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("close", (code) => resolve({ code, output }));
  });
}
