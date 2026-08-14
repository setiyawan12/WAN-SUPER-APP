import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureKey } from "./create-fixture-key.mjs";

const serviceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(serviceDirectory, "docker-compose.local.yml");
const environmentFile = path.join(serviceDirectory, ".env.local");
const exampleEnvironmentFile = path.join(serviceDirectory, ".env.local.example");
const runtimeDirectory = path.join(serviceDirectory, ".runtime");
const composeEnvironmentFile = path.join(runtimeDirectory, "compose.env");
const fixturePathFile = path.join(runtimeDirectory, "fixture-dir");
const command = process.argv[2] ?? "up";
const extraArguments = process.argv.slice(3);

await main();

async function main() {
  if (!["up", "ps", "logs", "down", "config"].includes(command)) {
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
  await writeFile(composeEnvironmentFile, `WAN_SSH_FIXTURE_DIR=${escapeEnvironment(fixtureDirectory)}\nWAN_SSH_DOCKER_SUBNET=${subnet}\n`, { mode: 0o600 });
  try {
    await compose(["--profile", "fixture", "up", "--build", "--wait", "--wait-timeout", "120"]);
  } catch (error) {
    await compose(["--profile", "fixture", "down", "--remove-orphans"], true);
    await cleanupFixture();
    throw error;
  }
  process.stdout.write("\nWAN SSH Web: http://127.0.0.1:5179\n");
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

async function compose(arguments_, allowFailure = false) {
  const args = ["compose", "--env-file", composeEnvironmentFile, "-f", composeFile, ...arguments_];
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