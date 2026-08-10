import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AuditAction,
  AuditActorType,
  AuditEventRecord,
  AuditMetadata,
  AuditOutcome,
  RouterRepository,
} from "../data/repository.js";

const actionSchema = z.enum([
  "api_key.created",
  "api_key.revoked",
  "provider_credential.created",
  "provider_credential.updated",
  "provider_credential.deleted",
  "provider_credential.verified",
  "generation.succeeded",
  "generation.failed",
  "generation.cancelled",
]);
const actorTypeSchema = z.enum(["firebase", "api-key", "dev-static", "system"]);
const outcomeSchema = z.enum(["succeeded", "failed", "cancelled"]);
const metadataValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const metadataSchema = z.record(metadataValueSchema).refine((metadata) => (
  Object.keys(metadata).length <= 16
  && Object.keys(metadata).every((key) => /^[a-zA-Z0-9_.-]{1,64}$/.test(key))
), "Audit metadata supports at most 16 simple keys.");

export interface AuditInput {
  workspaceId: string;
  actorType: AuditActorType;
  actorId?: string;
  action: AuditAction;
  resourceType: "api_key" | "provider_credential" | "generation";
  resourceId?: string;
  requestId: string;
  outcome: AuditOutcome;
  metadata?: AuditMetadata;
  occurredAt?: Date;
}

export interface AuditRecorder {
  record(input: AuditInput): Promise<AuditEventRecord | undefined>;
  list(workspaceId: string, limit?: number): Promise<AuditEventRecord[]>;
}

export interface AuditObserver {
  failed(action: AuditAction, error: unknown): void;
}

function eventKey(input: AuditInput): string {
  return createHash("sha256")
    .update([
      input.workspaceId,
      input.requestId,
      input.action,
      input.resourceType,
      input.resourceId ?? "",
      input.outcome,
    ].join(":"))
    .digest("hex");
}

export class AuditService implements AuditRecorder {
  constructor(
    private readonly repository: RouterRepository,
    private readonly observer?: AuditObserver,
  ) {}

  async record(input: AuditInput): Promise<AuditEventRecord> {
    const action = actionSchema.parse(input.action);
    const actorType = actorTypeSchema.parse(input.actorType);
    const outcome = outcomeSchema.parse(input.outcome);
    const metadata = metadataSchema.parse(input.metadata ?? {});
    try {
      return await this.repository.appendAuditEvent({
        id: randomUUID(),
        eventKey: eventKey(input),
        workspaceId: input.workspaceId,
        actorType,
        actorId: input.actorId?.slice(0, 256) ?? null,
        action,
        resourceType: input.resourceType,
        resourceId: input.resourceId?.slice(0, 256) ?? null,
        requestId: input.requestId.slice(0, 128),
        outcome,
        metadata,
        occurredAt: input.occurredAt ?? new Date(),
      });
    } catch (error) {
      this.observer?.failed(action, error);
      throw error;
    }
  }

  list(workspaceId: string, limit?: number): Promise<AuditEventRecord[]> {
    return this.repository.listAuditEvents(workspaceId, limit);
  }
}

export const noopAuditRecorder: AuditRecorder = {
  async record() { return undefined; },
  async list() { return []; },
};