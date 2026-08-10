import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const databaseUrl = process.env.WAN_TEST_DATABASE_URL?.trim();

if (!databaseUrl) throw new Error("Backup/restore rehearsal requires WAN_TEST_DATABASE_URL.");
if (["live", "prod", "production"].includes((process.env.WAN_ENV ?? "").toLowerCase())) {
  throw new Error("Backup/restore rehearsal must not run against a production environment.");
}

const parsedUrl = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
  throw new Error("Backup/restore rehearsal requires a PostgreSQL URL.");
}
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHosts.has(parsedUrl.hostname) && process.env.WAN_QA_ALLOW_REMOTE_DATABASE !== "true") {
  throw new Error("Backup/restore rehearsal requires explicit opt-in for a non-loopback database.");
}

const suffix = randomBytes(6).toString("hex");
const sourceDatabase = `wan_router_backup_source_${suffix}`;
const targetDatabase = `wan_router_backup_target_${suffix}`;
const temporaryDirectory = mkdtempSync(path.join(root, ".qa-backup-"));
const dumpPath = path.join(temporaryDirectory, "wan-router.dump");
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const createdDatabases = [];

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionUrl(database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function runMigrator(connectionString) {
  const result = spawnSync(process.execPath, ["dist/src/data/migrate.js"], {
    cwd: root,
    env: { ...process.env, WAN_DATABASE_URL: connectionString },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
}

function runPostgresClient(command, args, stdio) {
  const dockerArgs = ["run", "--rm", "-i"];
  let host = parsedUrl.hostname;
  if (loopbackHosts.has(host)) {
    host = "host.docker.internal";
    if (process.platform === "linux") dockerArgs.push("--add-host", "host.docker.internal:host-gateway");
  }
  dockerArgs.push("-e", "PGPASSWORD");
  const sslMode = parsedUrl.searchParams.get("sslmode");
  if (sslMode) dockerArgs.push("-e", "PGSSLMODE");
  dockerArgs.push(
    "postgres:17-alpine",
    command,
    "--host", host,
    "--port", parsedUrl.port || "5432",
    "--username", decodeURIComponent(parsedUrl.username),
    ...args,
  );
  const result = spawnSync("docker", dockerArgs, {
    cwd: root,
    env: {
      ...process.env,
      PGPASSWORD: decodeURIComponent(parsedUrl.password),
      ...(sslMode ? { PGSSLMODE: sslMode } : {}),
    },
    stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
}

async function createDatabase(name) {
  await adminPool.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0 ENCODING 'UTF8'`);
  createdDatabases.push(name);
}

async function dropDatabase(name) {
  await adminPool.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await adminPool.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
}

async function seedSource(connectionString) {
  const pool = new Pool({ connectionString, max: 1 });
  const seed = {
    userId: randomUUID(),
    workspaceId: randomUUID(),
    apiKeyId: randomUUID(),
    credentialId: randomUUID(),
    generationId: `gen_backup_${suffix}`,
    attemptId: randomUUID(),
    reservationId: randomUUID(),
    auditId: randomUUID(),
  };
  const now = new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO users (id, firebase_uid) VALUES ($1, $2)", [seed.userId, `backup-${suffix}`]);
    await client.query("INSERT INTO workspaces (id, owner_id, name) VALUES ($1, $2, 'Backup Rehearsal')", [seed.workspaceId, seed.userId]);
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [seed.workspaceId, seed.userId]);
    await client.query(
      `INSERT INTO api_keys (id, workspace_id, name, environment, prefix, digest, scopes)
       VALUES ($1, $2, 'Backup key', 'dev', 'wan_sk_dev_backup', 'backup-digest-only', $3)`,
      [seed.apiKeyId, seed.workspaceId, ["models:read", "chat:write"]],
    );
    await client.query(
      `INSERT INTO provider_credentials
        (id, workspace_id, provider, name, ciphertext, ciphertext_iv, ciphertext_tag,
         wrapped_key, wrapped_key_iv, wrapped_key_tag, key_version, masked_value)
       VALUES ($1, $2, 'mock', 'Backup credential', 'ciphertext', 'iv', 'tag',
         'wrapped-key', 'wrapped-iv', 'wrapped-tag', 'backup-v1', 'mock...safe')`,
      [seed.credentialId, seed.workspaceId],
    );
    await client.query(
      `INSERT INTO generations
        (id, workspace_id, api_key_id, request_id, requested_model, resolved_model, status,
         prompt_tokens, completion_tokens, total_tokens, usage_estimated,
         request_started_at, first_token_at, completed_at)
       VALUES ($1, $2, $3, $4, 'mock/echo', 'mock/echo', 'succeeded', 7, 5, 12, false, $5, $5, $5)`,
      [seed.generationId, seed.workspaceId, seed.apiKeyId, `req_${seed.generationId}`, now],
    );
    await client.query(
      `INSERT INTO provider_attempts
        (id, generation_id, workspace_id, provider_id, endpoint_id, credential_id, status,
         prompt_tokens, completion_tokens, total_tokens, usage_estimated, started_at, first_token_at, completed_at)
       VALUES ($1, $2, $3, 'mock', 'mock-primary', $4, 'succeeded', 7, 5, 12, false, $5, $5, $5)`,
      [seed.attemptId, seed.generationId, seed.workspaceId, seed.credentialId, now],
    );
    for (const [dimension, quantity] of [["prompt_tokens", 7], ["completion_tokens", 5], ["total_tokens", 12]]) {
      await client.query(
        `INSERT INTO usage_ledger (generation_id, workspace_id, dimension, quantity, estimated, created_at)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [seed.generationId, seed.workspaceId, dimension, quantity, now],
      );
    }
    await client.query(
      `INSERT INTO admission_reservations
        (id, workspace_id, credential_id, generation_id, minute_bucket, day_bucket,
         reserved_tokens, reserved_cost_micros, actual_tokens, actual_cost_micros,
         status, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 16, 0, 12, 0, 'settled', $5, $5)`,
      [seed.reservationId, seed.workspaceId, seed.apiKeyId, seed.generationId, now, now.toISOString().slice(0, 10)],
    );
    await client.query(
      `INSERT INTO audit_events
        (id, event_key, workspace_id, actor_type, action, resource_type,
         resource_id, request_id, outcome, metadata, occurred_at)
       VALUES ($1, $2, $3, 'system', 'generation.succeeded', 'generation',
         $4, $5, 'succeeded', $6::jsonb, $7)`,
      [
        seed.auditId,
        `backup-rehearsal:${seed.auditId}`,
        seed.workspaceId,
        seed.generationId,
        `req_audit_${seed.auditId}`,
        JSON.stringify({ source: "backup-restore-rehearsal" }),
        now,
      ],
    );
    await client.query("COMMIT");
    return seed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function verifyRestored(connectionString, seed) {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.equal(migrations.rowCount, 6);
    const workspace = await pool.query(
      `SELECT w.owner_id, wm.role FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = w.owner_id
       WHERE w.id = $1`,
      [seed.workspaceId],
    );
    assert.deepEqual(workspace.rows[0], { owner_id: seed.userId, role: "owner" });
    assert.equal((await pool.query("SELECT digest FROM api_keys WHERE id = $1", [seed.apiKeyId])).rows[0].digest, "backup-digest-only");
    assert.deepEqual(
      (await pool.query("SELECT ciphertext, wrapped_key, masked_value FROM provider_credentials WHERE id = $1", [seed.credentialId])).rows[0],
      { ciphertext: "ciphertext", wrapped_key: "wrapped-key", masked_value: "mock...safe" },
    );
    assert.deepEqual(
      (await pool.query("SELECT status, total_tokens FROM generations WHERE id = $1", [seed.generationId])).rows[0],
      { status: "succeeded", total_tokens: 12 },
    );
    for (const [table, count] of [["provider_attempts", 1], ["usage_ledger", 3], ["admission_reservations", 1]]) {
      const result = await pool.query(`SELECT count(*) AS count FROM ${table} WHERE generation_id = $1`, [seed.generationId]);
      assert.equal(Number(result.rows[0].count), count);
    }
    assert.equal((await pool.query("SELECT metadata FROM audit_events WHERE id = $1", [seed.auditId])).rows[0].metadata.source, "backup-restore-rehearsal");
    assert.deepEqual(
      (await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal")).rows.map((row) => row.tgname),
      ["audit_events_immutable_write"],
    );
    await assert.rejects(pool.query("UPDATE audit_events SET outcome = 'failed' WHERE id = $1", [seed.auditId]), /audit_events are immutable/);
    await assert.rejects(
      pool.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [randomUUID(), seed.userId]),
      /foreign key constraint/,
    );
  } finally {
    await pool.end();
  }
}

try {
  await createDatabase(sourceDatabase);
  await createDatabase(targetDatabase);
  const sourceUrl = connectionUrl(sourceDatabase);
  const targetUrl = connectionUrl(targetDatabase);
  runMigrator(sourceUrl);
  const seed = await seedSource(sourceUrl);

  const dumpOutput = openSync(dumpPath, "w", 0o600);
  try {
    runPostgresClient("pg_dump", ["--dbname", sourceDatabase, "--format", "custom", "--no-owner", "--no-privileges"], ["ignore", dumpOutput, "inherit"]);
  } finally {
    closeSync(dumpOutput);
  }
  assert.ok(statSync(dumpPath).size > 1024, "Backup artifact is unexpectedly small.");

  const dumpInput = openSync(dumpPath, "r");
  try {
    runPostgresClient(
      "pg_restore",
      ["--dbname", targetDatabase, "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges"],
      [dumpInput, "inherit", "inherit"],
    );
  } finally {
    closeSync(dumpInput);
  }

  await verifyRestored(targetUrl, seed);
  runMigrator(targetUrl);
  await verifyRestored(targetUrl, seed);
  assert.equal(existsSync(scriptPath), true, "Backup rehearsal script disappeared during execution.");
  console.log("Backup/restore rehearsal passed (custom dump, core data, constraints, audit trigger, idempotent migration). ");
} finally {
  for (const name of createdDatabases.reverse()) {
    await dropDatabase(name).catch((error) => console.error(`Failed to drop ${name}:`, error));
  }
  await adminPool.end();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}