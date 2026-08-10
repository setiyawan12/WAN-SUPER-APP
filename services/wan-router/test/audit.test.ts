import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryRouterRepository } from "../src/data/memory.js";
import { AuditService } from "../src/observability/audit.js";

test("audit events are idempotent, tenant scoped, and reject complex metadata", async () => {
  const repository = new InMemoryRouterRepository();
  const audit = new AuditService(repository);
  const input = {
    workspaceId: "workspace_a",
    actorType: "firebase" as const,
    actorId: "user_a",
    action: "api_key.created" as const,
    resourceType: "api_key" as const,
    resourceId: "key_a",
    requestId: "req_audit_test",
    outcome: "succeeded" as const,
    metadata: { environment: "dev", scopes_count: 2 },
    occurredAt: new Date("2026-08-08T01:00:00.000Z"),
  };

  const first = await audit.record(input);
  const repeated = await audit.record(input);
  assert.equal(first.id, repeated.id);
  assert.equal((await repository.listAuditEvents("workspace_a")).length, 1);
  assert.equal((await repository.listAuditEvents("workspace_b")).length, 0);

  await assert.rejects(audit.record({
    ...input,
    requestId: "req_audit_invalid",
    metadata: { request_body: { secret: "must-not-be-stored" } } as never,
  }));
});