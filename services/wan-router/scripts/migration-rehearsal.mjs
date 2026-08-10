import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "migrations");
const databaseUrl = process.env.WAN_TEST_DATABASE_URL?.trim();

if (!databaseUrl) throw new Error("Migration rehearsal requires WAN_TEST_DATABASE_URL.");
if (["live", "prod", "production"].includes((process.env.WAN_ENV ?? "").toLowerCase())) {
  throw new Error("Migration rehearsal must not run against a production environment.");
}

const parsedDatabaseUrl = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
  throw new Error("Migration rehearsal requires a PostgreSQL URL.");
}
const loopbackHostnames = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHostnames.has(parsedDatabaseUrl.hostname) && process.env.WAN_QA_ALLOW_REMOTE_DATABASE !== "true") {
  throw new Error("Migration rehearsal requires explicit opt-in for a non-loopback database.");
}

const schema = `wan_router_rehearsal_${randomBytes(8).toString("hex")}`;
const quotedSchema = `"${schema}"`;
const scopedDatabaseUrl = new URL(databaseUrl);
const existingOptions = scopedDatabaseUrl.searchParams.get("options")?.trim();
scopedDatabaseUrl.searchParams.set(
  "options",
  [existingOptions, `-c search_path=${schema}`].filter(Boolean).join(" "),
);

const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const rehearsalPool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  options: `-c search_path=${schema}`,
});

async function migrationFiles() {
  return (await readdir(migrationsDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
}

async function applyLegacySchema(files) {
  for (const file of files.filter((name) => name < "006_")) {
    const sql = await readFile(path.join(migrationsDirectory, file), "utf8");
    const client = await rehearsalPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function runCurrentMigrator() {
  const result = spawnSync(process.execPath, ["dist/src/data/migrate.js"], {
    cwd: root,
    env: {
      ...process.env,
      WAN_DATABASE_URL: scopedDatabaseUrl.toString(),
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Current migration runner failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function seedLegacyContract() {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const apiKeyId = randomUUID();
  const credentialId = randomUUID();
  const generationId = `gen_rehearsal_${randomBytes(6).toString("hex")}`;
  const attemptId = randomUUID();
  const reservationId = randomUUID();
  const now = new Date();

  await rehearsalPool.query("INSERT INTO users (id, firebase_uid) VALUES ($1, $2)", [userId, `qa-${userId}`]);
  await rehearsalPool.query("INSERT INTO workspaces (id, owner_id, name) VALUES ($1, $2, $3)", [
    workspaceId,
    userId,
    "Migration Rehearsal",
  ]);
  await rehearsalPool.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [workspaceId, userId],
  );
  await rehearsalPool.query(
    `INSERT INTO api_keys (id, workspace_id, name, environment, prefix, digest, scopes)
     VALUES ($1, $2, 'Legacy key', 'dev', 'wan_sk_dev_rehearsal', 'digest-only', $3)`,
    [apiKeyId, workspaceId, ["models:read", "chat:write"]],
  );
  await rehearsalPool.query(
    `INSERT INTO provider_credentials
      (id, workspace_id, provider, name, ciphertext, ciphertext_iv, ciphertext_tag,
       wrapped_key, wrapped_key_iv, wrapped_key_tag, key_version, masked_value)
     VALUES ($1, $2, 'mock', 'Legacy credential', 'ciphertext', 'iv', 'tag',
       'wrapped', 'wrapped-iv', 'wrapped-tag', 'legacy-v1', 'mock...safe')`,
    [credentialId, workspaceId],
  );
  await rehearsalPool.query(
    `INSERT INTO generations
      (id, workspace_id, api_key_id, request_id, requested_model, resolved_model, status,
       prompt_tokens, completion_tokens, total_tokens, usage_estimated,
       request_started_at, first_token_at, completed_at)
     VALUES ($1, $2, $3, $4, 'mock/echo', 'mock/echo', 'succeeded', 3, 2, 5, false, $5, $5, $5)`,
    [generationId, workspaceId, apiKeyId, `req_${generationId}`, now],
  );
  await rehearsalPool.query(
    `INSERT INTO provider_attempts
      (id, generation_id, workspace_id, provider_id, endpoint_id, credential_id, status,
       prompt_tokens, completion_tokens, total_tokens, usage_estimated, started_at, first_token_at, completed_at)
     VALUES ($1, $2, $3, 'mock', 'mock-primary', $4, 'succeeded', 3, 2, 5, false, $5, $5, $5)`,
    [attemptId, generationId, workspaceId, credentialId, now],
  );
  await rehearsalPool.query(
    `INSERT INTO usage_ledger (generation_id, workspace_id, dimension, quantity, estimated, created_at)
     VALUES ($1, $2, 'total_tokens', 5, false, $3)`,
    [generationId, workspaceId, now],
  );
  await rehearsalPool.query(
    `INSERT INTO admission_reservations
      (id, workspace_id, credential_id, generation_id, minute_bucket, day_bucket,
       reserved_tokens, reserved_cost_micros, actual_tokens, actual_cost_micros,
       status, created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 8, 0, 5, 0, 'settled', $5, $5)`,
    [reservationId, workspaceId, apiKeyId, generationId, now, now.toISOString().slice(0, 10)],
  );

  return { workspaceId, apiKeyId, generationId };
}

async function verifyApplicationRollbackContract(seed) {
  const usedAt = new Date();
  await rehearsalPool.query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1", [seed.apiKeyId, usedAt]);
  const key = await rehearsalPool.query("SELECT workspace_id, status, last_used_at FROM api_keys WHERE id = $1", [
    seed.apiKeyId,
  ]);
  assert.equal(key.rows[0].workspace_id, seed.workspaceId);
  assert.equal(key.rows[0].status, "active");
  assert.ok(key.rows[0].last_used_at);

  const generation = await rehearsalPool.query(
    "SELECT status, total_tokens FROM generations WHERE id = $1 AND workspace_id = $2",
    [seed.generationId, seed.workspaceId],
  );
  assert.deepEqual(generation.rows[0], { status: "succeeded", total_tokens: 5 });
  assert.equal(
    Number((await rehearsalPool.query("SELECT count(*) AS count FROM provider_attempts WHERE generation_id = $1", [seed.generationId])).rows[0].count),
    1,
  );
  assert.equal(
    Number((await rehearsalPool.query("SELECT count(*) AS count FROM admission_reservations WHERE generation_id = $1", [seed.generationId])).rows[0].count),
    1,
  );
}

async function verifyAuditContract(seed) {
  const auditId = randomUUID();
  await rehearsalPool.query(
    `INSERT INTO audit_events
      (id, event_key, workspace_id, actor_type, actor_id, action, resource_type,
       resource_id, request_id, outcome, metadata, occurred_at)
     VALUES ($1, $2, $3, 'system', NULL, 'generation.succeeded', 'generation',
       $4, $5, 'succeeded', '{"source":"migration-rehearsal"}'::jsonb, now())`,
    [auditId, `migration-rehearsal:${auditId}`, seed.workspaceId, seed.generationId, `req_audit_${auditId}`],
  );
  await assert.rejects(
    rehearsalPool.query("UPDATE audit_events SET outcome = 'failed' WHERE id = $1", [auditId]),
    /audit_events are immutable/,
  );
  return auditId;
}

await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
try {
  const files = await migrationFiles();
  assert.ok(files.includes("006_audit_events.sql"), "Audit migration fixture is missing.");
  await applyLegacySchema(files);
  const seed = await seedLegacyContract();

  runCurrentMigrator();
  await verifyApplicationRollbackContract(seed);
  const auditId = await verifyAuditContract(seed);

  runCurrentMigrator();
  const applied = await rehearsalPool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(applied.rows.map((row) => row.version), files);
  assert.equal(
    Number((await rehearsalPool.query("SELECT count(*) AS count FROM audit_events WHERE id = $1", [auditId])).rows[0].count),
    1,
  );
  await verifyApplicationRollbackContract(seed);

  console.log(`Migration rehearsal passed (${files.length} forward migrations, application rollback contract, idempotent rerun).`);
} finally {
  await rehearsalPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  await adminPool.end();
}