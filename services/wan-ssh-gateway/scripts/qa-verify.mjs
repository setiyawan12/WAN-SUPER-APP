import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(serviceDirectory, "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronCommand = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const sentinel = `WAN_SSH_QA_PRIVATE_${crypto.randomUUID()}`;
const sentinelFile = path.join(serviceDirectory, ".runtime", "qa-private.key");
let stackStarted = false;

if (["production", "prod", "live"].includes((process.env.WAN_SSH_ENV ?? "").toLowerCase())) {
  throw new Error("SSH web QA must not run against a production environment");
}

try {
  run("Gateway build and unit/integration tests", npmCommand, ["run", "ssh-gateway:test"], root);
  run("Web production build", npmCommand, ["run", "build:ssh-web"], root);
  run("Desktop SSH build", npmCommand, ["run", "build:ssh"], root);
  run("Desktop SSH regression", npmCommand, ["--prefix", "modules/ssh", "test"], root);
  run("Renderer typecheck", path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--noEmit"], root);
  run("Wrapper syntax", process.execPath, ["--check", "scripts/local-stack.mjs"], serviceDirectory);
  run("Protocol E2E syntax", process.execPath, ["--check", "scripts/local-e2e.mjs"], serviceDirectory);
  run("Browser E2E syntax", process.execPath, ["--check", "scripts/browser-e2e.mjs"], serviceDirectory);
  run("OPS-SSH-01 artifacts", npmCommand, ["run", "ops:verify"], serviceDirectory);

  run("Clean previous local stack", npmCommand, ["run", "ssh-web:down"], root, true);
  mkdirSync(path.dirname(sentinelFile), { recursive: true });
  writeFileSync(sentinelFile, `${sentinel}\n`, { mode: 0o600, flag: "w" });
  run("Build and start hardened local stack", npmCommand, ["run", "ssh-web:up"], root);
  stackStarted = true;
  verifyComposeAndContainers();
  run("Real WebSocket and OpenSSH terminal E2E", npmCommand, ["run", "test:ssh-web:e2e"], root);
  run("Browser quick-connect and mobile E2E", electronCommand, ["scripts/browser-e2e.cjs"], serviceDirectory);
  await verifySecretAbsence();
  run("Production dependency High/Critical audit", npmCommand, ["audit", "--omit=dev", "--audit-level=high"], serviceDirectory);
  console.log("\n[QA-SSH] Local MVP verification passed.");
} finally {
  if (stackStarted || existsSync(path.join(serviceDirectory, ".runtime", "compose.env"))) {
    run("Cleanup local stack and fixture key", npmCommand, ["run", "ssh-web:down"], root, true);
  }
  rmSync(path.join(serviceDirectory, ".runtime"), { recursive: true, force: true });
}

function verifyComposeAndContainers() {
  console.log("\n[QA-SSH] Compose and container policy inspection");
  const composeEnvironmentFile = path.join(serviceDirectory, ".runtime", "compose.env");
  const composeFile = path.join(serviceDirectory, "docker-compose.local.yml");
  const rendered = JSON.parse(capture("docker", ["compose", "--env-file", composeEnvironmentFile, "-f", composeFile, "--profile", "fixture", "config", "--format", "json"], serviceDirectory));
  const services = rendered.services;
  assert.deepEqual(services.gateway.ports ?? [], []);
  assert.deepEqual(services["ssh-target"].ports ?? [], []);
  assert.equal(services.web.ports.length, 1);
  assert.equal(services.web.ports[0].host_ip, "127.0.0.1");
  assert.equal(services.web.ports[0].published, "5179");
  assert.equal(services.gateway.read_only, true);
  assert.equal(services.web.read_only, true);
  assert.ok(services.gateway.cap_drop.includes("ALL"));
  assert.ok(services.web.cap_drop.includes("ALL"));
  assert.equal(JSON.stringify(services.gateway).includes("docker.sock"), false);
  assert.equal(JSON.stringify(services.gateway).includes(".ssh"), false);

  const containers = [
    ["wan-ssh-gateway-gateway-1", "node"],
    ["wan-ssh-gateway-web-1", "101"],
    ["wan-ssh-gateway-ssh-target-1", ""]
  ];
  for (const [container, expectedUser] of containers) {
    const inspection = JSON.parse(capture("docker", ["inspect", container], root))[0];
    assert.equal(inspection.State.Health.Status, "healthy");
    assert.equal(inspection.HostConfig.ReadonlyRootfs, container !== "wan-ssh-gateway-ssh-target-1");
    if (expectedUser) assert.equal(inspection.Config.User, expectedUser);
  }
  const gatewayInspection = JSON.parse(capture("docker", ["inspect", "wan-ssh-gateway-gateway-1"], root))[0];
  assert.equal(gatewayInspection.Mounts.length, 0);
  const targetInspection = JSON.parse(capture("docker", ["inspect", "wan-ssh-gateway-ssh-target-1"], root))[0];
  assert.equal(targetInspection.Mounts.length, 2);
  assert.ok(targetInspection.Mounts.some((mount) => /id_ed25519\.pub$/.test(mount.Source) && mount.Destination === "/run/fixture/id_ed25519.pub"));
  assert.ok(targetInspection.Mounts.some((mount) => /password\.hash$/.test(mount.Source) && mount.Destination === "/run/fixture/password.hash"));
}

async function verifySecretAbsence() {
  console.log("\n[QA-SSH] Secret and build-context leak inspection");
  const fixtureDirectory = readFileSync(path.join(serviceDirectory, ".runtime", "fixture-dir"), "utf8").trim();
  const privateKey = readFileSync(path.join(fixtureDirectory, "id_ed25519"), "utf8");
  const privateMarker = uniquePrivateKeyMarker(privateKey);
  const password = readFileSync(path.join(fixtureDirectory, "password"), "utf8").trim();
  const markers = [sentinel, privateMarker, password];
  const containers = ["wan-ssh-gateway-gateway-1", "wan-ssh-gateway-web-1", "wan-ssh-gateway-ssh-target-1"];
  const images = ["wan-ssh-gateway-gateway:latest", "wan-ssh-gateway-web:latest"];
  for (const container of containers) {
    assertNoMarkers(capture("docker", ["inspect", container], root), markers, `${container} inspect`);
    assertNoMarkers(capture("docker", ["logs", container], root, true), markers, `${container} logs`);
    await assertCommandHasNoMarkers("docker", ["export", container], root, markers, `${container} filesystem`);
  }
  for (const image of images) {
    assertNoMarkers(capture("docker", ["history", "--no-trunc", image], root), markers, `${image} history`);
    const containerId = capture("docker", ["create", image], root).trim();
    try {
      await assertCommandHasNoMarkers("docker", ["export", containerId], root, markers, `${image} filesystem`);
    } finally {
      run(`Remove ${image} inspection container`, "docker", ["rm", containerId], root, true);
    }
  }
}

function assertNoMarkers(content, markers, label) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  for (const marker of markers) assert.equal(buffer.includes(Buffer.from(marker)), false, `${label} contains a private marker`);
}

function uniquePrivateKeyMarker(value) {
  const bodyLines = value.split("\n").filter((line) => line && !line.startsWith("-----"));
  assert.ok(bodyLines[1]?.length >= 48, "Fixture private-key body is unexpectedly short");
  return bodyLines[1].slice(-48);
}

function assertCommandHasNoMarkers(command, args, cwd, markers, label) {
  const markerBuffers = markers.map((marker) => Buffer.from(marker));
  const overlapBytes = Math.max(...markerBuffers.map((marker) => marker.length)) - 1;
  return new Promise((resolve, reject) => {
    console.log(`\n[QA-SSH] Stream-scan ${label}`);
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let carry = Buffer.alloc(0);
    let stderr = "";
    let markerError;
    child.stdout.on("data", (chunk) => {
      if (markerError) return;
      const searchable = Buffer.concat([carry, chunk]);
      for (const marker of markerBuffers) {
        if (searchable.includes(marker)) {
          markerError = new Error(`${label} contains a private marker`);
          child.kill("SIGTERM");
          return;
        }
      }
      carry = overlapBytes > 0 ? Buffer.from(searchable.subarray(Math.max(0, searchable.length - overlapBytes))) : Buffer.alloc(0);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (markerError) reject(markerError);
      else if (code !== 0) reject(new Error(`${label} stream scan failed with code ${code}${signal ? ` (${signal})` : ""}: ${stderr}`));
      else resolve();
    });
  });
}

function run(label, command, args, cwd, allowFailure = false) {
  console.log(`\n[QA-SSH] ${label}`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${label} failed with exit code ${result.status}`);
  return result.status ?? 1;
}

function capture(command, args, cwd, includeStderr = false) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return `${result.stdout}${includeStderr ? result.stderr : ""}`;
}