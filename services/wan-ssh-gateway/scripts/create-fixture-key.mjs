import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export async function createFixtureKey() {
  const directory = await mkdtemp(path.join(tmpdir(), "wan-ssh-fixture-"));
  const privateKeyPath = path.join(directory, "id_ed25519");
  const passwordPath = path.join(directory, "password");
  const passwordHashPath = path.join(directory, "password.hash");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "wan-ssh-local-fixture", "-f", privateKeyPath]);
  const password = `WAN_SSH_FIXTURE_${randomBytes(24).toString("base64url")}`;
  const passwordHash = (await capture("openssl", ["passwd", "-6", "-stdin"], `${password}\n`)).trim();
  if (!passwordHash.startsWith("$6$")) throw new Error("OpenSSL did not generate a SHA-512 password hash");
  await Promise.all([
    writeFile(passwordPath, `${password}\n`, { mode: 0o600 }),
    writeFile(passwordHashPath, `${passwordHash}\n`, { mode: 0o600 }),
    writeFile(path.join(directory, "README.txt"), "Disposable WAN SSH local fixture credentials. Delete with npm run ssh-web:down.\n", { mode: 0o600 })
  ]);
  return { directory, privateKeyPath, passwordPath, passwordHashPath };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function capture(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with code ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === path.resolve(process.argv[1])) {
  const fixture = await createFixtureKey();
  process.stdout.write(`${JSON.stringify(fixture)}\n`);
}