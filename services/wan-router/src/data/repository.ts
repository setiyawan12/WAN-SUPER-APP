import type { GatewayScope } from "../auth/authenticator.js";
import type { TokenUsage } from "../inference/contracts.js";

export type ApiKeyStatus = "active" | "revoked";

export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  environment: "dev" | "staging" | "live";
  prefix: string;
  digest: string;
  scopes: GatewayScope[];
  status: ApiKeyStatus;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreateApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  environment: ApiKeyRecord["environment"];
  prefix: string;
  digest: string;
  scopes: GatewayScope[];
  expiresAt: Date | null;
}

export type ProviderCredentialStatus = "active" | "disabled" | "invalid";

export interface ProviderCredentialRecord {
  id: string;
  workspaceId: string;
  provider: string;
  name: string;
  ciphertext: string;
  ciphertextIv: string;
  ciphertextTag: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  keyVersion: string;
  maskedValue: string;
  modelFilters: string[];
  priority: number;
  status: ProviderCredentialStatus;
  lastVerifiedAt: Date | null;
  lastVerificationError: string | null;
  createdAt: Date;
  rotatedAt: Date | null;
  updatedAt: Date;
}

export interface CreateProviderCredentialRecord {
  id: string;
  workspaceId: string;
  provider: string;
  name: string;
  ciphertext: string;
  ciphertextIv: string;
  ciphertextTag: string;
  wrappedKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  keyVersion: string;
  maskedValue: string;
  modelFilters: string[];
  priority: number;
}

export interface UpdateProviderCredentialRecord {
  name?: string;
  ciphertext?: string;
  ciphertextIv?: string;
  ciphertextTag?: string;
  wrappedKey?: string;
  wrappedKeyIv?: string;
  wrappedKeyTag?: string;
  keyVersion?: string;
  maskedValue?: string;
  modelFilters?: string[];
  priority?: number;
  status?: ProviderCredentialStatus;
  rotatedAt?: Date;
}

export type GenerationStatus = "pending" | "succeeded" | "failed" | "cancelled";

export interface GenerationRecord {
  id: string;
  workspaceId: string;
  apiKeyId: string | null;
  requestId: string;
  requestedModel: string;
  resolvedModel: string | null;
  status: GenerationStatus;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageEstimated: boolean | null;
  errorCode: string | null;
  requestStartedAt: Date;
  firstTokenAt: Date | null;
  completedAt: Date | null;
}

export interface CreateGenerationRecord {
  id: string;
  workspaceId: string;
  apiKeyId: string | null;
  requestId: string;
  requestedModel: string;
  requestStartedAt: Date;
}

export interface FinalizeGenerationRecord {
  status: Exclude<GenerationStatus, "pending">;
  resolvedModel: string | null;
  usage?: TokenUsage;
  errorCode?: string;
  completedAt: Date;
}

export interface GenerationSummaryRecord {
  id: string;
  requestId: string;
  apiKeyId: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  providerEndpointId: string | null;
  status: GenerationStatus;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageEstimated: boolean | null;
  requestStartedAt: Date;
  firstTokenAt: Date | null;
  completedAt: Date | null;
}

export interface UsageSummaryRecord {
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  generations: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    pending: number;
  };
  estimatedGenerations: number;
}

export type ProviderAttemptStatus = "pending" | "succeeded" | "failed" | "cancelled";

export interface ProviderAttemptRecord {
  id: string;
  generationId: string;
  workspaceId: string;
  providerId: string;
  endpointId: string;
  credentialId: string | null;
  status: ProviderAttemptStatus;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageEstimated: boolean | null;
  errorCode: string | null;
  startedAt: Date;
  firstTokenAt: Date | null;
  completedAt: Date | null;
}

export interface CreateProviderAttemptRecord {
  id: string;
  generationId: string;
  workspaceId: string;
  providerId: string;
  endpointId: string;
  credentialId: string | null;
  startedAt: Date;
}

export interface FinalizeProviderAttemptRecord {
  status: Exclude<ProviderAttemptStatus, "pending">;
  usage?: TokenUsage;
  errorCode?: string;
  completedAt: Date;
}

export interface UsageLedgerRecord {
  generationId: string;
  workspaceId: string;
  dimension: "prompt_tokens" | "completion_tokens" | "total_tokens";
  quantity: number;
  estimated: boolean;
  createdAt: Date;
}

export interface ReconciliationResult {
  generationsFinalized: number;
  attemptsFinalized: number;
  reservationsReleased: number;
}

export type AuditActorType = "firebase" | "api-key" | "dev-static" | "system";
export type AuditOutcome = "succeeded" | "failed" | "cancelled";
export type AuditAction =
  | "api_key.created"
  | "api_key.revoked"
  | "provider_credential.created"
  | "provider_credential.updated"
  | "provider_credential.deleted"
  | "provider_credential.verified"
  | "generation.succeeded"
  | "generation.failed"
  | "generation.cancelled";
export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface AuditEventRecord {
  id: string;
  eventKey: string;
  workspaceId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: AuditAction;
  resourceType: "api_key" | "provider_credential" | "generation";
  resourceId: string | null;
  requestId: string;
  outcome: AuditOutcome;
  metadata: AuditMetadata;
  occurredAt: Date;
}

export interface AppendAuditEventRecord extends AuditEventRecord {}

export interface RouterRepository {
  ensurePersonalWorkspace(firebaseUid: string): Promise<{ userId: string; workspaceId: string }>;
  createApiKey(input: CreateApiKeyRecord): Promise<ApiKeyRecord>;
  listApiKeys(workspaceId: string): Promise<ApiKeyRecord[]>;
  findApiKeyById(id: string): Promise<ApiKeyRecord | null>;
  revokeApiKey(workspaceId: string, id: string, revokedAt: Date): Promise<boolean>;
  touchApiKey(id: string, usedAt: Date): Promise<void>;
  createProviderCredential(input: CreateProviderCredentialRecord): Promise<ProviderCredentialRecord>;
  listProviderCredentials(workspaceId: string): Promise<ProviderCredentialRecord[]>;
  findProviderCredential(workspaceId: string, id: string): Promise<ProviderCredentialRecord | null>;
  updateProviderCredential(
    workspaceId: string,
    id: string,
    patch: UpdateProviderCredentialRecord,
  ): Promise<ProviderCredentialRecord | null>;
  deleteProviderCredential(workspaceId: string, id: string): Promise<boolean>;
  setProviderCredentialVerification(
    workspaceId: string,
    id: string,
    input: {
      status: ProviderCredentialStatus;
      verifiedAt: Date;
      error: string | null;
      expectedCiphertext?: string;
    },
  ): Promise<ProviderCredentialRecord | null>;
  createGeneration(input: CreateGenerationRecord): Promise<GenerationRecord>;
  markGenerationFirstToken(workspaceId: string, id: string, at: Date): Promise<void>;
  finalizeGeneration(
    workspaceId: string,
    id: string,
    input: FinalizeGenerationRecord,
  ): Promise<GenerationRecord | null>;
  findGeneration(workspaceId: string, id: string): Promise<GenerationRecord | null>;
  findGenerationByRequestId(workspaceId: string, requestId: string): Promise<GenerationRecord | null>;
  listGenerationSummaries(workspaceId: string, limit: number): Promise<GenerationSummaryRecord[]>;
  getUsageSummary(workspaceId: string): Promise<UsageSummaryRecord>;
  createProviderAttempt(input: CreateProviderAttemptRecord): Promise<ProviderAttemptRecord>;
  markProviderAttemptFirstToken(workspaceId: string, id: string, at: Date): Promise<void>;
  finalizeProviderAttempt(
    workspaceId: string,
    id: string,
    input: FinalizeProviderAttemptRecord,
  ): Promise<ProviderAttemptRecord | null>;
  listProviderAttempts(workspaceId: string, generationId: string): Promise<ProviderAttemptRecord[]>;
  listUsageLedger(workspaceId: string, generationId: string): Promise<UsageLedgerRecord[]>;
  appendAuditEvent(input: AppendAuditEventRecord): Promise<AuditEventRecord>;
  listAuditEvents(workspaceId: string, limit?: number): Promise<AuditEventRecord[]>;
  reconcileStaleGenerations(cutoff: Date, completedAt: Date): Promise<ReconciliationResult>;
}