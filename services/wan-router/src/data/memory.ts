import { createHash } from "node:crypto";
import type {
  AppendAuditEventRecord,
  ApiKeyRecord,
  AuditEventRecord,
  CreateGenerationRecord,
  CreateApiKeyRecord,
  CreateProviderAttemptRecord,
  CreateProviderCredentialRecord,
  FinalizeGenerationRecord,
  FinalizeProviderAttemptRecord,
  GenerationRecord,
  GenerationSummaryRecord,
  ProviderAttemptRecord,
  ProviderCredentialRecord,
  ReconciliationResult,
  RouterRepository,
  UpdateProviderCredentialRecord,
  UsageLedgerRecord,
  UsageSummaryRecord,
} from "./repository.js";

function stableId(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function cloneApiKey(record: ApiKeyRecord): ApiKeyRecord {
  return {
    ...record,
    scopes: [...record.scopes],
    createdAt: new Date(record.createdAt),
    expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt) : null,
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
  };
}

function cloneCredential(record: ProviderCredentialRecord): ProviderCredentialRecord {
  return {
    ...record,
    modelFilters: [...record.modelFilters],
    lastVerifiedAt: record.lastVerifiedAt ? new Date(record.lastVerifiedAt) : null,
    createdAt: new Date(record.createdAt),
    rotatedAt: record.rotatedAt ? new Date(record.rotatedAt) : null,
    updatedAt: new Date(record.updatedAt),
  };
}

function cloneGeneration(record: GenerationRecord): GenerationRecord {
  return {
    ...record,
    requestStartedAt: new Date(record.requestStartedAt),
    firstTokenAt: record.firstTokenAt ? new Date(record.firstTokenAt) : null,
    completedAt: record.completedAt ? new Date(record.completedAt) : null,
  };
}

function cloneAttempt(record: ProviderAttemptRecord): ProviderAttemptRecord {
  return {
    ...record,
    startedAt: new Date(record.startedAt),
    firstTokenAt: record.firstTokenAt ? new Date(record.firstTokenAt) : null,
    completedAt: record.completedAt ? new Date(record.completedAt) : null,
  };
}

function cloneAuditEvent(record: AuditEventRecord): AuditEventRecord {
  return {
    ...record,
    metadata: { ...record.metadata },
    occurredAt: new Date(record.occurredAt),
  };
}

function addSafeInteger(total: number, quantity: number): number {
  const result = total + quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(result)) {
    throw new Error("Generation usage exceeds the safe integer range.");
  }
  return result;
}

export class InMemoryRouterRepository implements RouterRepository {
  private readonly apiKeys = new Map<string, ApiKeyRecord>();
  private readonly providerCredentials = new Map<string, ProviderCredentialRecord>();
  private readonly generations = new Map<string, GenerationRecord>();
  private readonly providerAttempts = new Map<string, ProviderAttemptRecord>();
  private readonly usageLedger = new Map<string, UsageLedgerRecord>();
  private readonly auditEvents = new Map<string, AuditEventRecord>();

  async ensurePersonalWorkspace(firebaseUid: string): Promise<{ userId: string; workspaceId: string }> {
    return {
      userId: stableId("user", firebaseUid),
      workspaceId: stableId("workspace", firebaseUid),
    };
  }

  async createApiKey(input: CreateApiKeyRecord): Promise<ApiKeyRecord> {
    if (this.apiKeys.has(input.id)) throw new Error(`API key ${input.id} already exists.`);
    const record: ApiKeyRecord = {
      ...input,
      scopes: [...input.scopes],
      status: "active",
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.apiKeys.set(record.id, record);
    return cloneApiKey(record);
  }

  async listApiKeys(workspaceId: string): Promise<ApiKeyRecord[]> {
    return [...this.apiKeys.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(cloneApiKey);
  }

  async findApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const record = this.apiKeys.get(id);
    return record ? cloneApiKey(record) : null;
  }

  async revokeApiKey(workspaceId: string, id: string, revokedAt: Date): Promise<boolean> {
    const record = this.apiKeys.get(id);
    if (!record || record.workspaceId !== workspaceId || record.status !== "active") return false;
    record.status = "revoked";
    record.revokedAt = new Date(revokedAt);
    return true;
  }

  async touchApiKey(id: string, usedAt: Date): Promise<void> {
    const record = this.apiKeys.get(id);
    if (record?.status === "active") record.lastUsedAt = new Date(usedAt);
  }

  async createProviderCredential(input: CreateProviderCredentialRecord): Promise<ProviderCredentialRecord> {
    if (this.providerCredentials.has(input.id)) throw new Error(`Provider credential ${input.id} already exists.`);
    const now = new Date();
    const record: ProviderCredentialRecord = {
      ...input,
      modelFilters: [...input.modelFilters],
      status: "active",
      lastVerifiedAt: null,
      lastVerificationError: null,
      createdAt: now,
      rotatedAt: null,
      updatedAt: now,
    };
    this.providerCredentials.set(record.id, record);
    return cloneCredential(record);
  }

  async listProviderCredentials(workspaceId: string): Promise<ProviderCredentialRecord[]> {
    return [...this.providerCredentials.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(cloneCredential);
  }

  async findProviderCredential(workspaceId: string, id: string): Promise<ProviderCredentialRecord | null> {
    const record = this.providerCredentials.get(id);
    return record?.workspaceId === workspaceId ? cloneCredential(record) : null;
  }

  async updateProviderCredential(
    workspaceId: string,
    id: string,
    patch: UpdateProviderCredentialRecord,
  ): Promise<ProviderCredentialRecord | null> {
    const record = this.providerCredentials.get(id);
    if (!record || record.workspaceId !== workspaceId) return null;
    Object.assign(record, patch, { updatedAt: new Date() });
    if (patch.modelFilters) record.modelFilters = [...patch.modelFilters];
    return cloneCredential(record);
  }

  async deleteProviderCredential(workspaceId: string, id: string): Promise<boolean> {
    const record = this.providerCredentials.get(id);
    return record?.workspaceId === workspaceId ? this.providerCredentials.delete(id) : false;
  }

  async setProviderCredentialVerification(
    workspaceId: string,
    id: string,
    input: {
      status: ProviderCredentialRecord["status"];
      verifiedAt: Date;
      error: string | null;
      expectedCiphertext?: string;
    },
  ): Promise<ProviderCredentialRecord | null> {
    const record = this.providerCredentials.get(id);
    if (!record || record.workspaceId !== workspaceId) return null;
    if (input.expectedCiphertext !== undefined && record.ciphertext !== input.expectedCiphertext) return null;
    record.status = input.status;
    record.lastVerifiedAt = new Date(input.verifiedAt);
    record.lastVerificationError = input.error;
    record.updatedAt = new Date();
    return cloneCredential(record);
  }

  async createGeneration(input: CreateGenerationRecord): Promise<GenerationRecord> {
    if (this.generations.has(input.id)) throw new Error(`Generation ${input.id} already exists.`);
    const record: GenerationRecord = {
      ...input,
      apiKeyId: input.apiKeyId,
      resolvedModel: null,
      status: "pending",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageEstimated: null,
      errorCode: null,
      requestStartedAt: new Date(input.requestStartedAt),
      firstTokenAt: null,
      completedAt: null,
    };
    this.generations.set(record.id, record);
    return cloneGeneration(record);
  }

  async markGenerationFirstToken(workspaceId: string, id: string, at: Date): Promise<void> {
    const record = this.generations.get(id);
    if (record?.workspaceId === workspaceId && record.status === "pending" && !record.firstTokenAt) {
      record.firstTokenAt = new Date(at);
    }
  }

  async finalizeGeneration(
    workspaceId: string,
    id: string,
    input: FinalizeGenerationRecord,
  ): Promise<GenerationRecord | null> {
    const record = this.generations.get(id);
    if (!record || record.workspaceId !== workspaceId || record.status !== "pending") return null;
    record.status = input.status;
    record.resolvedModel = input.resolvedModel;
    record.promptTokens = input.usage?.prompt_tokens ?? null;
    record.completionTokens = input.usage?.completion_tokens ?? null;
    record.totalTokens = input.usage?.total_tokens ?? null;
    record.usageEstimated = input.usage ? input.usage.estimated === true : null;
    record.errorCode = input.errorCode ?? null;
    record.completedAt = new Date(input.completedAt);
    if (input.status === "succeeded" && input.usage) {
      const dimensions = [
        ["prompt_tokens", input.usage.prompt_tokens],
        ["completion_tokens", input.usage.completion_tokens],
        ["total_tokens", input.usage.total_tokens],
      ] as const;
      for (const [dimension, quantity] of dimensions) {
        this.usageLedger.set(`${id}:${dimension}`, {
          generationId: id,
          workspaceId,
          dimension,
          quantity,
          estimated: input.usage.estimated === true,
          createdAt: new Date(input.completedAt),
        });
      }
    }
    return cloneGeneration(record);
  }

  async findGeneration(workspaceId: string, id: string): Promise<GenerationRecord | null> {
    const record = this.generations.get(id);
    return record?.workspaceId === workspaceId ? cloneGeneration(record) : null;
  }

  async findGenerationByRequestId(workspaceId: string, requestId: string): Promise<GenerationRecord | null> {
    const record = [...this.generations.values()]
      .filter((candidate) => candidate.workspaceId === workspaceId && candidate.requestId === requestId)
      .sort((left, right) => (
        right.requestStartedAt.getTime() - left.requestStartedAt.getTime() || right.id.localeCompare(left.id)
      ))[0];
    return record ? cloneGeneration(record) : null;
  }

  async listGenerationSummaries(workspaceId: string, limit: number): Promise<GenerationSummaryRecord[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    return [...this.generations.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => (
        right.requestStartedAt.getTime() - left.requestStartedAt.getTime() || right.id.localeCompare(left.id)
      ))
      .slice(0, boundedLimit)
      .map((record) => {
        const attempts = [...this.providerAttempts.values()]
          .filter((attempt) => attempt.workspaceId === workspaceId && attempt.generationId === record.id)
          .sort((left, right) => (
            Number(right.status === "succeeded") - Number(left.status === "succeeded")
            || right.startedAt.getTime() - left.startedAt.getTime()
            || right.id.localeCompare(left.id)
          ));
        return {
          id: record.id,
          requestId: record.requestId,
          apiKeyId: record.apiKeyId,
          requestedModel: record.requestedModel,
          resolvedModel: record.resolvedModel,
          providerEndpointId: attempts[0]?.endpointId ?? null,
          status: record.status,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          totalTokens: record.totalTokens,
          usageEstimated: record.usageEstimated,
          requestStartedAt: new Date(record.requestStartedAt),
          firstTokenAt: record.firstTokenAt ? new Date(record.firstTokenAt) : null,
          completedAt: record.completedAt ? new Date(record.completedAt) : null,
        };
      });
  }

  async getUsageSummary(workspaceId: string): Promise<UsageSummaryRecord> {
    const records = [...this.generations.values()].filter((record) => record.workspaceId === workspaceId);
    const summary = records.reduce<UsageSummaryRecord>((current, record) => {
      current.generations.total = addSafeInteger(current.generations.total, 1);
      current.generations[record.status] = addSafeInteger(current.generations[record.status], 1);
      return current;
    }, {
      totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      generations: { total: 0, succeeded: 0, failed: 0, cancelled: 0, pending: 0 },
      estimatedGenerations: 0,
    });
    const estimatedGenerationIds = new Set<string>();
    for (const entry of this.usageLedger.values()) {
      if (entry.workspaceId !== workspaceId) continue;
      if (entry.dimension === "prompt_tokens") {
        summary.totals.promptTokens = addSafeInteger(summary.totals.promptTokens, entry.quantity);
      } else if (entry.dimension === "completion_tokens") {
        summary.totals.completionTokens = addSafeInteger(summary.totals.completionTokens, entry.quantity);
      } else {
        summary.totals.totalTokens = addSafeInteger(summary.totals.totalTokens, entry.quantity);
      }
      if (entry.estimated) estimatedGenerationIds.add(entry.generationId);
    }
    summary.estimatedGenerations = estimatedGenerationIds.size;
    return summary;
  }

  async createProviderAttempt(input: CreateProviderAttemptRecord): Promise<ProviderAttemptRecord> {
    if (this.providerAttempts.has(input.id)) throw new Error(`Provider attempt ${input.id} already exists.`);
    const generation = this.generations.get(input.generationId);
    if (!generation || generation.workspaceId !== input.workspaceId) throw new Error("Generation was not found.");
    const record: ProviderAttemptRecord = {
      ...input,
      status: "pending",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageEstimated: null,
      errorCode: null,
      startedAt: new Date(input.startedAt),
      firstTokenAt: null,
      completedAt: null,
    };
    this.providerAttempts.set(record.id, record);
    return cloneAttempt(record);
  }

  async markProviderAttemptFirstToken(workspaceId: string, id: string, at: Date): Promise<void> {
    const record = this.providerAttempts.get(id);
    if (record?.workspaceId === workspaceId && record.status === "pending" && !record.firstTokenAt) {
      record.firstTokenAt = new Date(at);
    }
  }

  async finalizeProviderAttempt(
    workspaceId: string,
    id: string,
    input: FinalizeProviderAttemptRecord,
  ): Promise<ProviderAttemptRecord | null> {
    const record = this.providerAttempts.get(id);
    if (!record || record.workspaceId !== workspaceId || record.status !== "pending") return null;
    record.status = input.status;
    record.promptTokens = input.usage?.prompt_tokens ?? null;
    record.completionTokens = input.usage?.completion_tokens ?? null;
    record.totalTokens = input.usage?.total_tokens ?? null;
    record.usageEstimated = input.usage ? input.usage.estimated === true : null;
    record.errorCode = input.errorCode ?? null;
    record.completedAt = new Date(input.completedAt);
    return cloneAttempt(record);
  }

  async listProviderAttempts(workspaceId: string, generationId: string): Promise<ProviderAttemptRecord[]> {
    return [...this.providerAttempts.values()]
      .filter((record) => record.workspaceId === workspaceId && record.generationId === generationId)
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
      .map(cloneAttempt);
  }

  async listUsageLedger(workspaceId: string, generationId: string): Promise<UsageLedgerRecord[]> {
    return [...this.usageLedger.values()]
      .filter((record) => record.workspaceId === workspaceId && record.generationId === generationId)
      .sort((left, right) => left.dimension.localeCompare(right.dimension))
      .map((record) => ({ ...record, createdAt: new Date(record.createdAt) }));
  }

  async appendAuditEvent(input: AppendAuditEventRecord): Promise<AuditEventRecord> {
    const existing = this.auditEvents.get(input.eventKey);
    if (existing) return cloneAuditEvent(existing);
    const record = cloneAuditEvent(input);
    this.auditEvents.set(record.eventKey, record);
    return cloneAuditEvent(record);
  }

  async listAuditEvents(workspaceId: string, limit = 100): Promise<AuditEventRecord[]> {
    return [...this.auditEvents.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => (
        right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id)
      ))
      .slice(0, Math.max(1, Math.min(limit, 1_000)))
      .map(cloneAuditEvent);
  }

  async reconcileStaleGenerations(cutoff: Date, completedAt: Date): Promise<ReconciliationResult> {
    const staleGenerationIds = new Set(
      [...this.generations.values()]
        .filter((record) => record.status === "pending" && record.requestStartedAt < cutoff)
        .map((record) => record.id),
    );
    let attemptsFinalized = 0;
    for (const attempt of this.providerAttempts.values()) {
      if (
        attempt.status === "pending"
        && (attempt.startedAt < cutoff || staleGenerationIds.has(attempt.generationId))
      ) {
        attempt.status = "failed";
        attempt.errorCode = "reconciliation_timeout";
        attempt.completedAt = new Date(completedAt);
        attemptsFinalized += 1;
      }
    }
    let generationsFinalized = 0;
    for (const generationId of staleGenerationIds) {
      const generation = this.generations.get(generationId)!;
      generation.status = "failed";
      generation.errorCode = "reconciliation_timeout";
      generation.completedAt = new Date(completedAt);
      generationsFinalized += 1;
    }
    return { generationsFinalized, attemptsFinalized, reservationsReleased: 0 };
  }
}