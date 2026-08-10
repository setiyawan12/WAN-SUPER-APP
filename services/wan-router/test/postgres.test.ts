import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ApiKeyService } from "../src/auth/api-keys.js";
import { AdmissionService } from "../src/admission/limits.js";
import { PostgresAdmissionStore } from "../src/admission/postgres.js";
import { ProviderCredentialService } from "../src/control/provider-credentials.js";
import { createPostgresPool, PostgresRouterRepository } from "../src/data/postgres.js";
import { GenerationService } from "../src/inference/generations.js";
import { MockProviderCredentialVerifier, ProviderVerifierRegistry } from "../src/providers/credentials.js";
import { LocalEnvelopeCipher } from "../src/security/envelope.js";
import { AuditService } from "../src/observability/audit.js";
import { randomBytes } from "node:crypto";

const databaseUrl = process.env.WAN_TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const pool = databaseUrl ? createPostgresPool(databaseUrl) : null;
const repository = pool ? new PostgresRouterRepository(pool) : null;
const firebaseUidA = `postgres-test-a-${randomUUID()}`;
const firebaseUidB = `postgres-test-b-${randomUUID()}`;
let workspaceA = "";
let workspaceB = "";

before(async () => {
  if (!repository) return;
  workspaceA = (await repository.ensurePersonalWorkspace(firebaseUidA)).workspaceId;
  workspaceB = (await repository.ensurePersonalWorkspace(firebaseUidB)).workspaceId;
});

after(async () => {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable_write");
    await client.query(
      `DELETE FROM workspaces
       WHERE owner_id IN (SELECT id FROM users WHERE firebase_uid = ANY($1))`,
      [[firebaseUidA, firebaseUidB]],
    );
    await client.query("DELETE FROM users WHERE firebase_uid = ANY($1)", [[firebaseUidA, firebaseUidB]]);
    await client.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable_write");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await pool.end();
});

integrationTest("PostgreSQL persists tenant-scoped API keys and immediate revocation", async () => {
  assert.ok(repository);
  const service = new ApiKeyService(
    repository,
    "postgres-test-pepper-material-with-at-least-32-bytes",
    "dev",
  );
  const created = await service.create(workspaceA, {
    name: "Postgres integration",
    scopes: ["models:read", "chat:write"],
  });

  const stored = await repository.findApiKeyById(created.id);
  assert.ok(stored);
  assert.equal(stored.workspaceId, workspaceA);
  assert.notEqual(stored.digest, created.key);
  assert.equal((await service.list(workspaceB)).length, 0);

  const principal = await service.authenticate(created.key);
  assert.equal(principal.workspaceId, workspaceA);
  const touched = await repository.findApiKeyById(created.id);
  assert.ok(touched?.lastUsedAt);

  assert.equal(await repository.revokeApiKey(workspaceB, created.id, new Date()), false);
  assert.equal((await repository.findApiKeyById(created.id))?.status, "active");
  await service.revoke(workspaceA, created.id);
  await assert.rejects(service.authenticate(created.key));
});

integrationTest("PostgreSQL personal workspace resolution is stable and isolated", async () => {
  assert.ok(repository);
  const againA = await repository.ensurePersonalWorkspace(firebaseUidA);
  const againB = await repository.ensurePersonalWorkspace(firebaseUidB);
  assert.equal(againA.workspaceId, workspaceA);
  assert.equal(againB.workspaceId, workspaceB);
  assert.notEqual(workspaceA, workspaceB);

  const memberships = await pool!.query<{ workspace_id: string; firebase_uid: string }>(
    `SELECT wm.workspace_id, u.firebase_uid
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE u.firebase_uid = ANY($1)
     ORDER BY u.firebase_uid`,
    [[firebaseUidA, firebaseUidB]],
  );
  assert.equal(memberships.rowCount, 2);
  assert.deepEqual(new Set(memberships.rows.map((row) => row.workspace_id)), new Set([workspaceA, workspaceB]));
});

integrationTest("PostgreSQL stores encrypted provider credentials without plaintext", async () => {
  assert.ok(repository);
  const credentials = new ProviderCredentialService(
    repository,
    new LocalEnvelopeCipher(randomBytes(32)),
    new ProviderVerifierRegistry(new Map([["mock", new MockProviderCredentialVerifier()]])),
  );
  const plaintext = "mock_provider_postgres_secret_3377";
  const created = await credentials.create(workspaceA, {
    provider: "mock",
    name: `Postgres mock ${randomUUID()}`,
    secret: plaintext,
  });

  const row = await pool!.query<{
    ciphertext: string;
    wrapped_key: string;
    masked_value: string;
  }>("SELECT ciphertext, wrapped_key, masked_value FROM provider_credentials WHERE id = $1", [created.id]);
  assert.equal(row.rowCount, 1);
  assert.doesNotMatch(JSON.stringify(row.rows[0]), new RegExp(plaintext));
  assert.equal(row.rows[0].masked_value, "mock...3377");
  assert.ok(row.rows[0].ciphertext);
  assert.ok(row.rows[0].wrapped_key);

  assert.equal((await credentials.list(workspaceB)).length, 0);
  assert.equal((await credentials.verify(workspaceA, created.id, new AbortController().signal)).status, "active");
  await credentials.delete(workspaceA, created.id);
  assert.equal((await pool!.query("SELECT 1 FROM provider_credentials WHERE id = $1", [created.id])).rowCount, 0);
});

integrationTest("PostgreSQL finalizes generation attempts and token ledger atomically", async () => {
  assert.ok(repository);
  const generations = new GenerationService(repository);
  const generationId = `gen_postgres_${randomUUID()}`;
  await generations.start({
    id: generationId,
    workspaceId: workspaceA,
    requestId: `req_postgres_${randomUUID()}`,
    requestedModel: "openai/test-model",
    startedAt: new Date(),
  });
  const attempts = generations.attempts(workspaceA, generationId);
  const attemptId = await attempts.begin({
    providerId: "openai",
    endpointId: "openai-official",
    startedAt: new Date(),
  });
  await attempts.firstToken(attemptId, new Date());
  await generations.firstToken(workspaceA, generationId, new Date());
  const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12, estimated: false };
  await attempts.finish(attemptId, { status: "succeeded", usage, completedAt: new Date() });
  await generations.succeed({
    workspaceId: workspaceA,
    generationId,
    resolvedModel: "openai/test-model",
    usage,
    completedAt: new Date(),
  });
  await generations.succeed({
    workspaceId: workspaceA,
    generationId,
    resolvedModel: "openai/test-model",
    usage,
    completedAt: new Date(),
  });

  const generation = await repository.findGeneration(workspaceA, generationId);
  assert.equal(generation?.status, "succeeded");
  assert.equal(generation?.totalTokens, 12);
  assert.ok(generation?.firstTokenAt);
  assert.equal(await repository.findGeneration(workspaceB, generationId), null);
  const storedAttempts = await repository.listProviderAttempts(workspaceA, generationId);
  assert.equal(storedAttempts.length, 1);
  assert.equal(storedAttempts[0].status, "succeeded");
  assert.equal(storedAttempts[0].totalTokens, 12);
  const ledger = await repository.listUsageLedger(workspaceA, generationId);
  assert.deepEqual(ledger.map(({ dimension, quantity }) => ({ dimension, quantity })), [
    { dimension: "completion_tokens", quantity: 5 },
    { dimension: "prompt_tokens", quantity: 7 },
    { dimension: "total_tokens", quantity: 12 },
  ]);
  assert.deepEqual(await repository.listUsageLedger(workspaceB, generationId), []);
});

integrationTest("PostgreSQL generation reads are tenant scoped, ordered, bounded, and aggregate correctly", async () => {
  assert.ok(repository);
  const generations = new GenerationService(repository);
  const before = await repository.getUsageSummary(workspaceA);
  const successId = `gen_read_success_${randomUUID()}`;
  const failedId = `gen_read_failed_${randomUUID()}`;
  const otherTenantId = `gen_read_other_${randomUUID()}`;
  const successStartedAt = new Date("2099-01-01T00:00:00.000Z");
  const failedStartedAt = new Date("2099-01-02T00:00:00.000Z");
  await generations.start({
    id: successId,
    workspaceId: workspaceA,
    requestId: `req_${successId}`,
    requestedModel: "openai/requested",
    startedAt: successStartedAt,
  });
  const attemptId = await generations.attempts(workspaceA, successId).begin({
    providerId: "openai",
    endpointId: "postgres-primary",
    startedAt: successStartedAt,
  });
  const usage = { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, estimated: true };
  await generations.attempts(workspaceA, successId).finish(attemptId, {
    status: "succeeded",
    usage,
    completedAt: successStartedAt,
  });
  await generations.succeed({
    workspaceId: workspaceA,
    generationId: successId,
    resolvedModel: "openai/resolved",
    usage,
    completedAt: successStartedAt,
  });
  await pool!.query(
    `UPDATE generations
     SET prompt_tokens = 800, completion_tokens = 500, total_tokens = 1300, usage_estimated = false
     WHERE id = $1 AND workspace_id = $2`,
    [successId, workspaceA],
  );
  await generations.start({
    id: failedId,
    workspaceId: workspaceA,
    requestId: `req_${failedId}`,
    requestedModel: "openai/requested",
    startedAt: failedStartedAt,
  });
  await generations.fail({
    workspaceId: workspaceA,
    generationId: failedId,
    status: "failed",
    errorCode: "provider_unavailable",
    completedAt: failedStartedAt,
  });
  await generations.start({
    id: otherTenantId,
    workspaceId: workspaceB,
    requestId: `req_${otherTenantId}`,
    requestedModel: "openai/private",
    startedAt: new Date("2100-01-01T00:00:00.000Z"),
  });

  assert.deepEqual((await repository.listGenerationSummaries(workspaceA, 1)).map(({ id }) => id), [failedId]);
  const summaries = await repository.listGenerationSummaries(workspaceA, 200);
  assert.deepEqual(summaries.slice(0, 2).map(({ id }) => id), [failedId, successId]);
  assert.equal(summaries.find(({ id }) => id === successId)?.providerEndpointId, "postgres-primary");
  assert.equal(summaries.some(({ id }) => id === otherTenantId), false);

  const afterSummary = await repository.getUsageSummary(workspaceA);
  assert.deepEqual(afterSummary.totals, {
    promptTokens: before.totals.promptTokens + 8,
    completionTokens: before.totals.completionTokens + 5,
    totalTokens: before.totals.totalTokens + 13,
  });
  assert.deepEqual(afterSummary.generations, {
    total: before.generations.total + 2,
    succeeded: before.generations.succeeded + 1,
    failed: before.generations.failed + 1,
    cancelled: before.generations.cancelled,
    pending: before.generations.pending,
  });
  assert.equal(afterSummary.estimatedGenerations, before.estimatedGenerations + 1);
});

integrationTest("PostgreSQL reconciliation finalizes stale pending records idempotently", async () => {
  assert.ok(repository);
  const generations = new GenerationService(repository);
  const generationId = `gen_stale_postgres_${randomUUID()}`;
  const startedAt = new Date(Date.now() - 10 * 60_000);
  await generations.start({
    id: generationId,
    workspaceId: workspaceA,
    requestId: `req_stale_postgres_${randomUUID()}`,
    requestedModel: "openai/test-model",
    startedAt,
  });
  const attemptId = await generations.attempts(workspaceA, generationId).begin({
    providerId: "openai",
    endpointId: "openai-official",
    startedAt,
  });
  const completedAt = new Date();
  assert.deepEqual(await generations.reconcileStale(new Date(Date.now() - 5 * 60_000), completedAt), {
    generationsFinalized: 1,
    attemptsFinalized: 1,
    reservationsReleased: 0,
  });
  assert.equal((await repository.findGeneration(workspaceA, generationId))?.status, "failed");
  assert.equal((await repository.findGeneration(workspaceA, generationId))?.errorCode, "reconciliation_timeout");
  const attempts = await repository.listProviderAttempts(workspaceA, generationId);
  assert.equal(attempts[0].id, attemptId);
  assert.equal(attempts[0].status, "failed");
  assert.deepEqual(await repository.listUsageLedger(workspaceA, generationId), []);
  assert.deepEqual(await generations.reconcileStale(new Date(Date.now() - 5 * 60_000), completedAt), {
    generationsFinalized: 0,
    attemptsFinalized: 0,
    reservationsReleased: 0,
  });

  const finalizedGenerationId = `gen_final_orphan_postgres_${randomUUID()}`;
  await generations.start({
    id: finalizedGenerationId,
    workspaceId: workspaceA,
    requestId: `req_final_orphan_postgres_${randomUUID()}`,
    requestedModel: "openai/test-model",
    startedAt,
  });
  const orphanAttemptId = await generations.attempts(workspaceA, finalizedGenerationId).begin({
    providerId: "openai",
    endpointId: "openai-official",
    startedAt,
  });
  await generations.fail({
    workspaceId: workspaceA,
    generationId: finalizedGenerationId,
    status: "failed",
    errorCode: "generation_finalized_first",
    completedAt,
  });
  assert.deepEqual(await generations.reconcileStale(new Date(Date.now() - 5 * 60_000), completedAt), {
    generationsFinalized: 0,
    attemptsFinalized: 1,
    reservationsReleased: 0,
  });
  const orphanAttempt = (await repository.listProviderAttempts(workspaceA, finalizedGenerationId))[0];
  assert.equal(orphanAttempt.id, orphanAttemptId);
  assert.equal(orphanAttempt.status, "failed");
  assert.equal(orphanAttempt.errorCode, "reconciliation_timeout");
});

integrationTest("PostgreSQL admission serializes parallel hard concurrency reservations", async () => {
  assert.ok(repository);
  const generations = new GenerationService(repository);
  const admission = new AdmissionService(new PostgresAdmissionStore(pool!), {
    requestsPerMinute: 100,
    maxConcurrent: 3,
    maxTokensPerRequest: 100,
    dailyTokenLimit: 1_000,
    dailyBudgetMicros: 1_000n,
  });
  const now = new Date();
  const generationIds = Array.from({ length: 20 }, () => `gen_admission_${randomUUID()}`);
  await Promise.all(generationIds.map((id) => generations.start({
    id,
    workspaceId: workspaceA,
    requestId: `req_${id}`,
    requestedModel: "openai/test-model",
    startedAt: now,
  })));
  const results = await Promise.allSettled(generationIds.map((generationId) => admission.reserve({
    workspaceId: workspaceA,
    credentialId: "key_parallel",
    generationId,
    requestedTokens: 10,
    reservedCostMicros: 10n,
    now,
  })));
  const accepted = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof admission.reserve>>> => (
    result.status === "fulfilled"
  ));
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 17);
  assert.ok(rejected.every(({ reason }) => reason instanceof Error && "code" in reason && reason.code === "concurrency_limit_exceeded"));

  await admission.settle(accepted[0].value.id, 8, 8n);
  await admission.release(accepted[1].value.id);
  await admission.release(accepted[2].value.id);
  const nextGenerationId = `gen_admission_${randomUUID()}`;
  await generations.start({
    id: nextGenerationId,
    workspaceId: workspaceA,
    requestId: `req_${nextGenerationId}`,
    requestedModel: "openai/test-model",
    startedAt: now,
  });
  await admission.reserve({
    workspaceId: workspaceA,
    credentialId: "key_parallel",
    generationId: nextGenerationId,
    requestedTokens: 10,
    reservedCostMicros: 10n,
    now,
  });
});

integrationTest("PostgreSQL audit events are idempotent, tenant scoped, and immutable", async () => {
  assert.ok(repository);
  const audit = new AuditService(repository);
  const input = {
    workspaceId: workspaceA,
    actorType: "firebase" as const,
    actorId: "postgres-audit-user",
    action: "api_key.created" as const,
    resourceType: "api_key" as const,
    resourceId: randomUUID(),
    requestId: `req_postgres_audit_${randomUUID()}`,
    outcome: "succeeded" as const,
    metadata: { environment: "dev", scopes_count: 2 },
  };
  const first = await audit.record(input);
  const repeated = await audit.record(input);
  assert.equal(first.id, repeated.id);
  assert.equal((await repository.listAuditEvents(workspaceA)).filter((event) => event.id === first.id).length, 1);
  assert.equal((await repository.listAuditEvents(workspaceB)).some((event) => event.id === first.id), false);
  await assert.rejects(pool!.query("UPDATE audit_events SET outcome = 'failed' WHERE id = $1", [first.id]), /immutable/);
  await assert.rejects(pool!.query("DELETE FROM audit_events WHERE id = $1", [first.id]), /immutable/);
});