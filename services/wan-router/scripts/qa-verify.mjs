import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDatabaseUrl = process.env.WAN_TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  console.error("QA-01 requires WAN_TEST_DATABASE_URL so PostgreSQL integration tests cannot be skipped.");
  process.exit(1);
}

if (["live", "prod", "production"].includes((process.env.WAN_ENV ?? "").toLowerCase())) {
  console.error("QA-01 verification must not run against a production environment.");
  process.exit(1);
}

const databaseHostname = new URL(testDatabaseUrl).hostname;
const loopbackHostnames = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHostnames.has(databaseHostname) && process.env.WAN_QA_ALLOW_REMOTE_DATABASE !== "true") {
  console.error("QA-01 requires WAN_QA_ALLOW_REMOTE_DATABASE=true before using a non-loopback database.");
  process.exit(1);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  WAN_DATABASE_URL: testDatabaseUrl,
  WAN_TEST_DATABASE_URL: testDatabaseUrl,
};

for (const requiredScript of ["scripts/migration-rehearsal.mjs", "scripts/backup-restore-rehearsal.mjs"]) {
  if (!existsSync(path.join(root, requiredScript))) {
    console.error(`QA-01 required script is missing: ${requiredScript}`);
    process.exit(1);
  }
}

function run(label, command, args, options = {}) {
  console.log(`\n[QA-01] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Build", npmCommand, ["run", "build"]);
run("Migrate test database", "node", ["dist/src/data/migrate.js"]);
run("Migration forward/application-rollback rehearsal", "node", ["scripts/migration-rehearsal.mjs"]);
run("PostgreSQL backup/restore rehearsal", "node", ["scripts/backup-restore-rehearsal.mjs"]);
const testFiles = readdirSync(path.join(root, "dist/test"))
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join("dist/test", file));
run("Unit, contract, HTTP, and PostgreSQL integration tests", "node", ["--test", ...testFiles]);
run("Secret scan", "node", ["dist/src/security/scan-secrets.js"]);
run("Observability resource validation", "node", ["dist/src/observability/validate-ops.js"]);

const tokenDirectory = mkdtempSync(path.join(tmpdir(), "wan-router-qa-"));
const tokenFile = path.join(tokenDirectory, "metrics-token");
writeFileSync(tokenFile, "qa-observability-token-at-least-32-bytes", { mode: 0o600 });

try {
  run("Observability Compose validation", "docker", [
    "compose",
    "-f",
    "docker-compose.observability.yml",
    "config",
    "--quiet",
  ], {
    env: { ...environment, WAN_METRICS_TOKEN_FILE: tokenFile },
  });
  run("Prometheus rule validation", "docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/promtool",
    "-v",
    `${path.join(root, "ops/prometheus")}:/work:ro`,
    "-w",
    "/work",
    "prom/prometheus:v3.5.0",
    "check",
    "rules",
    "alerts.yml",
  ]);
  run("Prometheus alert rehearsal", "docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/promtool",
    "-v",
    `${path.join(root, "ops/prometheus")}:/work:ro`,
    "-w",
    "/work",
    "prom/prometheus:v3.5.0",
    "test",
    "rules",
    "alert-tests.yml",
  ]);
  run("Cloud Monitoring Terraform format", "docker", [
    "run",
    "--rm",
    "-v",
    `${path.join(root, "ops/cloud-monitoring")}:/work`,
    "-w",
    "/work",
    "hashicorp/terraform:1.9.8",
    "fmt",
    "-check",
    "-diff",
  ]);
  run("Cloud Monitoring Terraform init", "docker", [
    "run",
    "--rm",
    "-v",
    `${path.join(root, "ops/cloud-monitoring")}:/work`,
    "-w",
    "/work",
    "hashicorp/terraform:1.9.8",
    "init",
    "-backend=false",
  ]);
  run("Cloud Monitoring Terraform validation", "docker", [
    "run",
    "--rm",
    "-v",
    `${path.join(root, "ops/cloud-monitoring")}:/work`,
    "-w",
    "/work",
    "hashicorp/terraform:1.9.8",
    "validate",
  ]);
} finally {
  rmSync(tokenDirectory, { recursive: true, force: true });
}

run("Production dependency High/Critical audit", npmCommand, ["audit", "--omit=dev", "--audit-level=high"]);
console.log("\n[QA-01] Repository verification passed.");