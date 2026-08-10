import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { GenerationService } from "../src/inference/generations.js";

test("generation service persists attempts, first token, final usage, and ledger exactly once", async () => {
  const repository = new InMemoryRouterRepository();
  const generations = new GenerationService(repository);
  const startedAt = new Date("2026-08-08T01:00:00.000Z");
  await generations.start({
    id: "gen_success",
    workspaceId: "workspace_a",
    apiKeyId: "key_a",
    requestId: "req_generation_success",
    requestedModel: "openai/test-model",
    startedAt,
  });
  const attempts = generations.attempts("workspace_a", "gen_success");
  const attemptId = await attempts.begin({
    providerId: "openai",
    endpointId: "openai-official",
    credentialId: "credential_a",
    startedAt,
  });
  const firstTokenAt = new Date("2026-08-08T01:00:01.000Z");
  await attempts.firstToken(attemptId, firstTokenAt);
  await generations.firstToken("workspace_a", "gen_success", firstTokenAt);
  const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, estimated: false };
  const completedAt = new Date("2026-08-08T01:00:02.000Z");
  await attempts.finish(attemptId, { status: "succeeded", usage, completedAt });
  await generations.succeed({
    workspaceId: "workspace_a",
    generationId: "gen_success",
    resolvedModel: "openai/test-model",
    usage,
    completedAt,
  });
  await generations.succeed({
    workspaceId: "workspace_a",
    generationId: "gen_success",
    resolvedModel: "openai/test-model",
    usage,
    completedAt,
  });

  const generation = await repository.findGeneration("workspace_a", "gen_success");
  assert.equal(generation?.status, "succeeded");
  assert.equal(generation?.totalTokens, 14);
  assert.equal(generation?.usageEstimated, false);
  assert.equal(generation?.firstTokenAt?.toISOString(), firstTokenAt.toISOString());
  const storedAttempts = await repository.listProviderAttempts("workspace_a", "gen_success");
  assert.equal(storedAttempts.length, 1);
  assert.equal(storedAttempts[0].status, "succeeded");
  assert.equal(storedAttempts[0].credentialId, "credential_a");
  assert.equal(storedAttempts[0].totalTokens, 14);
  assert.equal(storedAttempts[0].usageEstimated, false);
  assert.deepEqual(
    (await repository.listUsageLedger("workspace_a", "gen_success")).map(({ dimension, quantity }) => ({ dimension, quantity })),
    [
      { dimension: "completion_tokens", quantity: 4 },
      { dimension: "prompt_tokens", quantity: 10 },
      { dimension: "total_tokens", quantity: 14 },
    ],
  );
  assert.deepEqual(await repository.getUsageSummary("workspace_a"), {
    totals: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    generations: { total: 1, succeeded: 1, failed: 0, cancelled: 0, pending: 0 },
    estimatedGenerations: 0,
  });
});

test("failed and cancelled generations finalize without usage ledger or cross-tenant access", async () => {
  const repository = new InMemoryRouterRepository();
  const generations = new GenerationService(repository);
  for (const [id, status] of [["gen_failed", "failed"], ["gen_cancelled", "cancelled"]] as const) {
    await generations.start({
      id,
      workspaceId: "workspace_a",
      requestId: `req_${id}`,
      requestedModel: "openai/test-model",
      startedAt: new Date(),
    });
    await generations.fail({
      workspaceId: "workspace_a",
      generationId: id,
      status,
      errorCode: status === "cancelled" ? "request_cancelled" : "provider_unavailable",
      completedAt: new Date(),
    });
    assert.equal((await repository.findGeneration("workspace_a", id))?.status, status);
    assert.equal(await repository.findGeneration("workspace_b", id), null);
    assert.deepEqual(await repository.listUsageLedger("workspace_a", id), []);
  }
});

test("generation read models are tenant scoped, newest first, bounded, and aggregate stored metadata", async () => {
  const repository = new InMemoryRouterRepository();
  const generations = new GenerationService(repository);
  const olderAt = new Date("2026-08-08T02:00:00.000Z");
  const newerAt = new Date("2026-08-08T03:00:00.000Z");
  await generations.start({
    id: "gen_read_success",
    workspaceId: "workspace_a",
    apiKeyId: "key_read_a",
    requestId: "req_read_success",
    requestedModel: "openai/requested",
    startedAt: olderAt,
  });
  const attempts = generations.attempts("workspace_a", "gen_read_success");
  const successfulAttemptId = await attempts.begin({
    providerId: "openai",
    endpointId: "openai-primary",
    startedAt: olderAt,
  });
  const laterFailedAttemptId = await attempts.begin({
    providerId: "openai",
    endpointId: "openai-fallback",
    startedAt: new Date("2026-08-08T02:00:01.000Z"),
  });
  const usage = { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10, estimated: true };
  await attempts.finish(successfulAttemptId, { status: "succeeded", usage, completedAt: newerAt });
  await attempts.finish(laterFailedAttemptId, {
    status: "failed",
    errorCode: "provider_unavailable",
    completedAt: newerAt,
  });
  await generations.succeed({
    workspaceId: "workspace_a",
    generationId: "gen_read_success",
    resolvedModel: "openai/resolved",
    usage,
    completedAt: newerAt,
  });
  await generations.start({
    id: "gen_read_failed",
    workspaceId: "workspace_a",
    requestId: "req_read_failed",
    requestedModel: "openai/requested",
    startedAt: newerAt,
  });
  await generations.fail({
    workspaceId: "workspace_a",
    generationId: "gen_read_failed",
    status: "failed",
    errorCode: "provider_unavailable",
    completedAt: newerAt,
  });
  await generations.start({
    id: "gen_read_other_tenant",
    workspaceId: "workspace_b",
    requestId: "req_read_other_tenant",
    requestedModel: "openai/private",
    startedAt: new Date("2026-08-08T04:00:00.000Z"),
  });

  assert.deepEqual((await repository.listGenerationSummaries("workspace_a", 1)).map(({ id }) => id), [
    "gen_read_failed",
  ]);
  const summaries = await repository.listGenerationSummaries("workspace_a", 200);
  assert.deepEqual(summaries.map(({ id }) => id), ["gen_read_failed", "gen_read_success"]);
  assert.equal(summaries[1].providerEndpointId, "openai-primary");
  assert.equal(summaries.some(({ id }) => id === "gen_read_other_tenant"), false);
  assert.deepEqual(await repository.getUsageSummary("workspace_a"), {
    totals: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
    generations: { total: 2, succeeded: 1, failed: 1, cancelled: 0, pending: 0 },
    estimatedGenerations: 1,
  });
});

test("stale generation reconciliation finalizes pending records once without inventing usage", async () => {
  const repository = new InMemoryRouterRepository();
  const generations = new GenerationService(repository);
  const oldStartedAt = new Date("2026-08-08T01:00:00.000Z");
  const recentStartedAt = new Date("2026-08-08T01:09:00.000Z");
  await generations.start({
    id: "gen_stale",
    workspaceId: "workspace_a",
    requestId: "req_stale",
    requestedModel: "openai/test-model",
    startedAt: oldStartedAt,
  });
  const attemptId = await generations.attempts("workspace_a", "gen_stale").begin({
    providerId: "openai",
    endpointId: "openai-official",
    startedAt: oldStartedAt,
  });
  await generations.start({
    id: "gen_recent",
    workspaceId: "workspace_a",
    requestId: "req_recent",
    requestedModel: "openai/test-model",
    startedAt: recentStartedAt,
  });

  const completedAt = new Date("2026-08-08T01:10:00.000Z");
  assert.deepEqual(await generations.reconcileStale(new Date("2026-08-08T01:05:00.000Z"), completedAt), {
    generationsFinalized: 1,
    attemptsFinalized: 1,
    reservationsReleased: 0,
  });
  assert.equal((await repository.findGeneration("workspace_a", "gen_stale"))?.errorCode, "reconciliation_timeout");
  assert.equal((await repository.listProviderAttempts("workspace_a", "gen_stale"))[0].id, attemptId);
  assert.equal((await repository.listProviderAttempts("workspace_a", "gen_stale"))[0].status, "failed");
  assert.equal((await repository.findGeneration("workspace_a", "gen_recent"))?.status, "pending");
  assert.deepEqual(await repository.listUsageLedger("workspace_a", "gen_stale"), []);
  assert.deepEqual(await generations.reconcileStale(new Date("2026-08-08T01:05:00.000Z"), completedAt), {
    generationsFinalized: 0,
    attemptsFinalized: 0,
    reservationsReleased: 0,
  });

  await generations.start({
    id: "gen_final_with_orphan",
    workspaceId: "workspace_a",
    requestId: "req_final_with_orphan",
    requestedModel: "openai/test-model",
    startedAt: oldStartedAt,
  });
  const orphanAttemptId = await generations.attempts("workspace_a", "gen_final_with_orphan").begin({
    providerId: "openai",
    endpointId: "openai-official",
    startedAt: oldStartedAt,
  });
  await generations.fail({
    workspaceId: "workspace_a",
    generationId: "gen_final_with_orphan",
    status: "failed",
    errorCode: "generation_finalized_first",
    completedAt,
  });
  assert.deepEqual(await generations.reconcileStale(new Date("2026-08-08T01:05:00.000Z"), completedAt), {
    generationsFinalized: 0,
    attemptsFinalized: 1,
    reservationsReleased: 0,
  });
  const orphanAttempt = (await repository.listProviderAttempts("workspace_a", "gen_final_with_orphan"))[0];
  assert.equal(orphanAttempt.id, orphanAttemptId);
  assert.equal(orphanAttempt.status, "failed");
});