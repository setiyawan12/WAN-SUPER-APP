import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureKey } from "./create-fixture-key.mjs";

const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(serviceDirectory, "docker-compose.local.yml");
const firebaseOverlayFile = path.join(serviceDirectory, "docker-compose.firebase.yml");
const tailscaleOverlayFile = path.join(serviceDirectory, "docker-compose.tailscale.yml");
const webEnvironmentFile = path.resolve(serviceDirectory, "../../modules/ssh/ui/.env.local");
const environmentFile = path.join(serviceDirectory, ".env.local");
const exampleEnvironmentFile = path.join(serviceDirectory, ".env.local.example");
const runtimeDirectory = path.join(serviceDirectory, ".runtime");
const composeEnvironmentFile = path.join(runtimeDirectory, "compose.env");
const fixturePathFile = path.join(runtimeDirectory, "fixture-dir");
const overlayMarkerFile = path.join(runtimeDirectory, "firebase-overlay");
const tailscaleMarkerFile = path.join(runtimeDirectory, "tailscale-overlay");
const command = process.argv[2] ?? "up";
const extraArguments = process.argv.slice(3);

await main();

async function main() {
  if (!["up", "ps", "logs", "down", "config", "exec"].includes(command)) {
    throw new Error(`Unsupported ssh-web stack command: ${command}`);
  }
  if (command === "up") await up();
  else if (command === "down") await down();
  else await compose([command, ...extraArguments]);
}

async function up() {
  await verifyPrerequisites();
  await mkdir(runtimeDirectory, { recursive: true });
  if (!(await exists(environmentFile))) await copyFile(exampleEnvironmentFile, environmentFile);
  let fixtureDirectory;
  try {
    fixtureDirectory = (await readFile(fixturePathFile, "utf8")).trim();
    if (!fixtureDirectory
      || !(await exists(path.join(fixtureDirectory, "id_ed25519")))
      || !(await exists(path.join(fixtureDirectory, "password")))
      || !(await exists(path.join(fixtureDirectory, "password.hash")))) fixtureDirectory = undefined;
  } catch {}
  if (!fixtureDirectory) {
    const fixture = await createFixtureKey();
    fixtureDirectory = fixture.directory;
    await writeFile(fixturePathFile, `${fixtureDirectory}\n`, { mode: 0o600 });
  }
  const subnet = process.env.WAN_SSH_DOCKER_SUBNET || "172.30.0.0/24";
  const firebase = await firebaseOverlaySettings();
  await writeFile(
    composeEnvironmentFile,
    `WAN_SSH_FIXTURE_DIR=${escapeEnvironment(fixtureDirectory)}\nWAN_SSH_DOCKER_SUBNET=${subnet}\n${firebase.environment}`,
    { mode: 0o600 }
  );
  if (firebase.enabled) await writeFile(overlayMarkerFile, "1\n", { mode: 0o600 });
  else await rm(overlayMarkerFile, { force: true });
  // TS_AUTHKEY sengaja tidak ikut ditulis ke compose.env; Docker Compose
  // menginterpolasinya dari shell sehingga auth key tidak pernah menyentuh disk.
  const tailscale = Boolean(process.env.TS_AUTHKEY?.trim());
  if (tailscale) await writeFile(tailscaleMarkerFile, "1\n", { mode: 0o600 });
  else await rm(tailscaleMarkerFile, { force: true });
  try {
    await compose(["--profile", "fixture", "up", "--build", "--wait", "--wait-timeout", "120"]);
  } catch (error) {
    await compose(["--profile", "fixture", "down", "--remove-orphans"], true);
    await cleanupFixture();
    throw error;
  }
  process.stdout.write(`\nWAN SSH Web: ${firebase.enabled ? firebase.origin : "http://127.0.0.1:5179"}\n`);
  if (firebase.enabled) process.stdout.write("Auth mode: firebase (service account di-mount read-only)\n");
  if (tailscale) {
    process.stdout.write(`Egress: tailscale sidecar aktif (allowlist ${process.env.WAN_SSH_EGRESS_ALLOW_CIDRS || "100.64.0.0/10"})\n`);
    process.stdout.write("Verifikasi target: npm run ssh-web:tailscale-check -- <ip> [port]\n");
  }
  process.stdout.write(`Fixture host: ssh-target\nFixture port: 22\nFixture username: wan\nFixture private key: ${path.join(fixtureDirectory, "id_ed25519")}\n`);
  process.stdout.write(`Fixture password file: ${path.join(fixtureDirectory, "password")}\n`);
}

async function down() {
  if (await exists(composeEnvironmentFile)) {
    await compose(["--profile", "fixture", "down", "--remove-orphans", ...extraArguments], true);
  }
  await cleanupFixture();
}

async function cleanupFixture() {
  let fixtureDirectory;
  try { fixtureDirectory = (await readFile(fixturePathFile, "utf8")).trim(); } catch {}
  if (fixtureDirectory && path.dirname(fixtureDirectory) === path.resolve(process.env.TMPDIR || "/tmp")) {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
  await rm(runtimeDirectory, { recursive: true, force: true });
}

/**
 * Mode Firebase penuh aktif saat service account tersedia: dari
 * WAN_SSH_SERVICE_ACCOUNT_FILE, atau dari lokasi default di luar repository
 * (`~/.config/wan-ssh/service-account.json`) sehingga `ssh-web:up` langsung
 * berjalan tanpa environment variable dan kunci tidak pernah berada di dalam
 * project. Tanpa keduanya stack tetap berjalan pada mode dev-anonymous.
 *
 * Konfigurasi Web SDK diambil dari modules/ssh/ui/.env.local agar image web
 * dibangun dengan project yang sama seperti WAN SSH Desktop.
 */
async function firebaseOverlaySettings() {
  const configured = process.env.WAN_SSH_SERVICE_ACCOUNT_FILE?.trim();
  const resolved = path.resolve(configured || path.join(os.homedir(), ".config", "wan-ssh", "service-account.json"));
  if (!(await exists(resolved))) {
    if (configured) throw new Error(`WAN_SSH_SERVICE_ACCOUNT_FILE does not exist: ${resolved}`);
    return { enabled: false, environment: "" };
  }

  let webEnvironment;
  try {
    webEnvironment = await readFile(webEnvironmentFile, "utf8");
  } catch {
    throw new Error(`Firebase mode requires ${webEnvironmentFile} (copy modules/ssh/ui/.env.example)`);
  }
  const web = new Map();
  for (const line of webEnvironment.split("\n")) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#") || !entry.includes("=")) continue;
    const key = entry.slice(0, entry.indexOf("="));
    if (key.startsWith("VITE_FIREBASE_") && key !== "VITE_FIREBASE_AUTH_EMULATOR_HOST") {
      web.set(key, entry.slice(entry.indexOf("=") + 1).trim());
    }
  }
  for (const required of ["VITE_FIREBASE_API_KEY", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_DATABASE_URL", "VITE_FIREBASE_APP_ID"]) {
    if (!web.get(required)) throw new Error(`${required} is missing from ${webEnvironmentFile}`);
  }

  // Firebase hanya mengizinkan `localhost` sebagai authorized domain loopback,
  // sehingga stack Firebase dibuka di localhost, bukan 127.0.0.1.
  const origin = process.env.WAN_SSH_WEB_ORIGIN?.trim() || "http://localhost:5179";
  const lines = [
    `WAN_SSH_SERVICE_ACCOUNT_FILE=${escapeEnvironment(resolved)}`,
    `WAN_SSH_WEB_ORIGIN=${escapeEnvironment(origin)}`,
    ...[...web].map(([key, value]) => `${key}=${escapeEnvironment(value)}`)
  ];
  return { enabled: true, origin, environment: `${lines.join("\n")}\n` };
}

async function compose(arguments_, allowFailure = false) {
  const overlay = [
    ...(await exists(overlayMarkerFile)) ? ["-f", firebaseOverlayFile] : [],
    ...(await exists(tailscaleMarkerFile)) ? ["-f", tailscaleOverlayFile] : []
  ];
  const args = ["compose", "--env-file", composeEnvironmentFile, "-f", composeFile, ...overlay, ...arguments_];
  const code = await run("docker", args, { cwd: serviceDirectory });
  if (code !== 0 && !allowFailure) throw new Error(`docker compose exited with code ${code}`);
}

async function verifyPrerequisites() {
  for (const [program, args] of [["node", ["--version"]], ["npm", ["--version"]], ["docker", ["version"]], ["docker", ["compose", "version"]], ["ssh-keygen", ["-V"]], ["openssl", ["version"]]]) {
    const code = await run(program, args, { quiet: program === "ssh-keygen", acceptCodes: program === "ssh-keygen" ? [0, 1] : [0] });
    if (program === "ssh-keygen" && ![0, 1].includes(code)) throw new Error("ssh-keygen is required");
  }
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? serviceDirectory,
      stdio: options.quiet ? "ignore" : "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function escapeEnvironment(value) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "");
}

async function exists(filePath) {
  try { await access(filePath, constants.F_OK); return true; }
  catch { return false; }
}