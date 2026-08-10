import assert from "node:assert/strict";
import { test } from "node:test";
import { AdmissionService, type AdmissionRequest } from "../src/admission/limits.js";
import { InMemoryAdmissionStore } from "../src/admission/memory.js";
import { GatewayError } from "../src/errors.js";

const POLICY = {
  requestsPerMinute: 100,
  maxConcurrent: 3,
  maxTokensPerRequest: 100,
  dailyTokenLimit: 250,
  dailyBudgetMicros: 500n,
};

function request(index: number, overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    workspaceId: "workspace_a",
    credentialId: "key_a",
    generationId: `gen_${index}`,
    requestedTokens: 80,
    reservedCostMicros: 100n,
    now: new Date("2026-08-08T02:00:00.000Z"),
    ...overrides,
  };
}

test("atomic admission never exceeds the hard concurrency limit under parallel requests", async () => {
  const admission = new AdmissionService(new InMemoryAdmissionStore(), POLICY);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => admission.reserve(request(index))));
  const accepted = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(accepted.length, 3);
  assert.equal(rejected.length, 17);
  assert.ok(rejected.every(({ reason }) => reason instanceof GatewayError && reason.code === "concurrency_limit_exceeded"));
});

test("admission settlement releases concurrency but keeps actual daily token and budget usage", async () => {
  const admission = new AdmissionService(new InMemoryAdmissionStore(), POLICY);
  const first = await admission.reserve(request(1));
  const second = await admission.reserve(request(2));
  const third = await admission.reserve(request(3));
  await admission.settle(first.id, 80, 75n);
  await admission.release(second.id);
  await admission.release(third.id);

  const fourth = await admission.reserve(request(4, { requestedTokens: 100, reservedCostMicros: 300n }));
  await admission.settle(fourth.id, 90, 250n);
  await assert.rejects(
    admission.reserve(request(5, { requestedTokens: 100, reservedCostMicros: 100n })),
    (error: unknown) => error instanceof GatewayError && error.code === "token_quota_exceeded",
  );
});

test("admission distinguishes request token, rate, and budget failures", async () => {
  const tokenAdmission = new AdmissionService(new InMemoryAdmissionStore(), POLICY);
  await assert.rejects(
    tokenAdmission.reserve(request(1, { requestedTokens: 101 })),
    (error: unknown) => error instanceof GatewayError && error.code === "token_quota_exceeded",
  );

  const rateAdmission = new AdmissionService(new InMemoryAdmissionStore(), { ...POLICY, requestsPerMinute: 1, maxConcurrent: 10 });
  const rateReservation = await rateAdmission.reserve(request(2));
  await rateAdmission.release(rateReservation.id);
  await assert.rejects(
    rateAdmission.reserve(request(3)),
    (error: unknown) => error instanceof GatewayError && error.code === "rate_limit_exceeded",
  );

  const budgetAdmission = new AdmissionService(new InMemoryAdmissionStore(), {
    ...POLICY,
    maxConcurrent: 10,
    dailyTokenLimit: 1_000,
    dailyBudgetMicros: 150n,
  });
  const budgetReservation = await budgetAdmission.reserve(request(4, { reservedCostMicros: 100n }));
  await budgetAdmission.settle(budgetReservation.id, 10, 100n);
  await assert.rejects(
    budgetAdmission.reserve(request(5, { reservedCostMicros: 51n })),
    (error: unknown) => error instanceof GatewayError && error.code === "budget_exceeded",
  );
});

test("admission scopes rate by credential but concurrency by workspace", async () => {
  const admission = new AdmissionService(new InMemoryAdmissionStore(), { ...POLICY, maxConcurrent: 1 });
  await admission.reserve(request(1));
  await assert.rejects(
    admission.reserve(request(2, { credentialId: "key_b" })),
    (error: unknown) => error instanceof GatewayError && error.code === "concurrency_limit_exceeded",
  );
  await admission.reserve(request(3, { workspaceId: "workspace_b" }));
});

test("daily quota cannot be bypassed with another API key in the same workspace", async () => {
  const admission = new AdmissionService(new InMemoryAdmissionStore(), {
    ...POLICY,
    maxConcurrent: 10,
    dailyTokenLimit: 100,
    dailyBudgetMicros: 1_000n,
  });
  const first = await admission.reserve(request(1, { credentialId: "key_a", requestedTokens: 60 }));
  await admission.settle(first.id, 60, 60n);
  await assert.rejects(
    admission.reserve(request(2, { credentialId: "key_b", requestedTokens: 41 })),
    (error: unknown) => error instanceof GatewayError && error.code === "token_quota_exceeded",
  );
});