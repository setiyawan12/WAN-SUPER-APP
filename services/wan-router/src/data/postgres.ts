import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { GatewayScope } from "../auth/authenticator.js";
import type {
  AppendAuditEventRecord,
  ApiKeyRecord,
  AuditEventRecord,
  CreateApiKeyRecord,
  CreateGenerationRecord,
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

interface ApiKeyRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  name: string;
  environment: ApiKeyRecord["environment"];
  prefix: string;
  digest: string;
  scopes: string[];
  status: ApiKeyRecord["status"];
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

interface ProviderCredentialRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  provider: string;
  name: string;
  ciphertext: string;
  ciphertext_iv: string;
  ciphertext_tag: string;
  wrapped_key: string;
  wrapped_key_iv: string;
  wrapped_key_tag: string;
  key_version: string;
  masked_value: string;
  model_filters: string[];
  priority: number;
  status: ProviderCredentialRecord["status"];
  last_verified_at: Date | null;
  last_verification_error: string | null;
  created_at: Date;
  rotated_at: Date | null;
  updated_at: Date;
}

interface GenerationRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  api_key_id: string | null;
  request_id: string;
  requested_model: string;
  resolved_model: string | null;
  status: GenerationRecord["status"];
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usage_estimated: boolean | null;
  error_code: string | null;
  request_started_at: Date;
  first_token_at: Date | null;
  completed_at: Date | null;
}

interface GenerationSummaryRow extends QueryResultRow {
  id: string;
  api_key_id: string | null;
  request_id: string;
  requested_model: string;
  resolved_model: string | null;
  provider_endpoint_id: string | null;
  status: GenerationRecord["status"];
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usage_estimated: boolean | null;
  request_started_at: Date;
  first_token_at: Date | null;
  completed_at: Date | null;
}

interface UsageSummaryRow extends QueryResultRow {
  prompt_tokens: string;
  completion_tokens: string;
  total_tokens: string;
  generations_total: string;
  generations_succeeded: string;
  generations_failed: string;
  generations_cancelled: string;
  generations_pending: string;
  estimated_generations: string;
}

interface ProviderAttemptRow extends QueryResultRow {
  id: string;
  generation_id: string;
  workspace_id: string;
  provider_id: string;
  endpoint_id: string;
  credential_id: string | null;
  status: ProviderAttemptRecord["status"];
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usage_estimated: boolean | null;
  error_code: string | null;
  started_at: Date;
  first_token_at: Date | null;
  completed_at: Date | null;
}

interface UsageLedgerRow extends QueryResultRow {
  generation_id: string;
  workspace_id: string;
  dimension: UsageLedgerRecord["dimension"];
  quantity: number;
  estimated: boolean;
  created_at: Date;
}

interface AuditEventRow extends QueryResultRow {
  id: string;
  event_key: string;
  workspace_id: string;
  actor_type: AuditEventRecord["actorType"];
  actor_id: string | null;
  action: AuditEventRecord["action"];
  resource_type: AuditEventRecord["resourceType"];
  resource_id: string | null;
  request_id: string;
  outcome: AuditEventRecord["outcome"];
  metadata: AuditEventRecord["metadata"];
  occurred_at: Date;
}

function stableUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}:${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function apiKeyFromRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    environment: row.environment,
    prefix: row.prefix,
    digest: row.digest,
    scopes: row.scopes as GatewayScope[],
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function providerCredentialFromRow(row: ProviderCredentialRow): ProviderCredentialRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    name: row.name,
    ciphertext: row.ciphertext,
    ciphertextIv: row.ciphertext_iv,
    ciphertextTag: row.ciphertext_tag,
    wrappedKey: row.wrapped_key,
    wrappedKeyIv: row.wrapped_key_iv,
    wrappedKeyTag: row.wrapped_key_tag,
    keyVersion: row.key_version,
    maskedValue: row.masked_value,
    modelFilters: row.model_filters,
    priority: row.priority,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    lastVerificationError: row.last_verification_error,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    updatedAt: row.updated_at,
  };
}

function generationFromRow(row: GenerationRow): GenerationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    apiKeyId: row.api_key_id,
    requestId: row.request_id,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    status: row.status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    usageEstimated: row.usage_estimated,
    errorCode: row.error_code,
    requestStartedAt: row.request_started_at,
    firstTokenAt: row.first_token_at,
    completedAt: row.completed_at,
  };
}

function generationSummaryFromRow(row: GenerationSummaryRow): GenerationSummaryRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    apiKeyId: row.api_key_id,
    requestedModel: row.requested_model,
    resolvedModel: row.resolved_model,
    providerEndpointId: row.provider_endpoint_id,
    status: row.status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    usageEstimated: row.usage_estimated,
    requestStartedAt: row.request_started_at,
    firstTokenAt: row.first_token_at,
    completedAt: row.completed_at,
  };
}

function providerAttemptFromRow(row: ProviderAttemptRow): ProviderAttemptRecord {
  return {
    id: row.id,
    generationId: row.generation_id,
    workspaceId: row.workspace_id,
    providerId: row.provider_id,
    endpointId: row.endpoint_id,
    credentialId: row.credential_id,
    status: row.status,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    usageEstimated: row.usage_estimated,
    errorCode: row.error_code,
    startedAt: row.started_at,
    firstTokenAt: row.first_token_at,
    completedAt: row.completed_at,
  };
}

function usageLedgerFromRow(row: UsageLedgerRow): UsageLedgerRecord {
  return {
    generationId: row.generation_id,
    workspaceId: row.workspace_id,
    dimension: row.dimension,
    quantity: row.quantity,
    estimated: row.estimated,
    createdAt: row.created_at,
  };
}

function auditEventFromRow(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    eventKey: row.event_key,
    workspaceId: row.workspace_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    outcome: row.outcome,
    metadata: { ...row.metadata },
    occurredAt: row.occurred_at,
  };
}

function safeInteger(value: string, label: string): number {
  const integer = BigInt(value);
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds the safe integer range.`);
  }
  return Number(integer);
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresRouterRepository implements RouterRepository {
  constructor(private readonly pool: Pool) {}

  async ensurePersonalWorkspace(firebaseUid: string): Promise<{ userId: string; workspaceId: string }> {
    const proposedUserId = stableUuid("wan-router-user", firebaseUid);
    const workspaceId = stableUuid("wan-router-personal-workspace", firebaseUid);
    return transaction(this.pool, async (client) => {
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (id, firebase_uid)
         VALUES ($1, $2)
         ON CONFLICT (firebase_uid) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [proposedUserId, firebaseUid],
      );
      const userId = userResult.rows[0].id;
      await client.query(
        `INSERT INTO workspaces (id, owner_id, name)
         VALUES ($1, $2, 'Personal Workspace')
         ON CONFLICT (id) DO NOTHING`,
        [workspaceId, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'`,
        [workspaceId, userId],
      );
      return { userId, workspaceId };
    });
  }

  async createApiKey(input: CreateApiKeyRecord): Promise<ApiKeyRecord> {
    const result = await this.pool.query<ApiKeyRow>(
      `INSERT INTO api_keys
        (id, workspace_id, name, environment, prefix, digest, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.id || randomUUID(),
        input.workspaceId,
        input.name,
        input.environment,
        input.prefix,
        input.digest,
        input.scopes,
        input.expiresAt,
      ],
    );
    return apiKeyFromRow(result.rows[0]);
  }

  async listApiKeys(workspaceId: string): Promise<ApiKeyRecord[]> {
    const result = await this.pool.query<ApiKeyRow>(
      `SELECT * FROM api_keys
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId],
    );
    return result.rows.map(apiKeyFromRow);
  }

  async findApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const result = await this.pool.query<ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1", [id]);
    return result.rows[0] ? apiKeyFromRow(result.rows[0]) : null;
  }

  async revokeApiKey(workspaceId: string, id: string, revokedAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys
       SET status = 'revoked', revoked_at = $3
       WHERE id = $1 AND workspace_id = $2 AND status = 'active'`,
      [id, workspaceId, revokedAt],
    );
    return result.rowCount === 1;
  }

  async touchApiKey(id: string, usedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE api_keys SET last_used_at = $2
       WHERE id = $1 AND status = 'active'`,
      [id, usedAt],
    );
  }

  async createProviderCredential(input: CreateProviderCredentialRecord): Promise<ProviderCredentialRecord> {
    const result = await this.pool.query<ProviderCredentialRow>(
      `INSERT INTO provider_credentials (
        id, workspace_id, provider, name,
        ciphertext, ciphertext_iv, ciphertext_tag,
        wrapped_key, wrapped_key_iv, wrapped_key_tag, key_version,
        masked_value, model_filters, priority
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14
      ) RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.provider,
        input.name,
        input.ciphertext,
        input.ciphertextIv,
        input.ciphertextTag,
        input.wrappedKey,
        input.wrappedKeyIv,
        input.wrappedKeyTag,
        input.keyVersion,
        input.maskedValue,
        input.modelFilters,
        input.priority,
      ],
    );
    return providerCredentialFromRow(result.rows[0]);
  }

  async listProviderCredentials(workspaceId: string): Promise<ProviderCredentialRecord[]> {
    const result = await this.pool.query<ProviderCredentialRow>(
      `SELECT * FROM provider_credentials
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId],
    );
    return result.rows.map(providerCredentialFromRow);
  }

  async findProviderCredential(workspaceId: string, id: string): Promise<ProviderCredentialRecord | null> {
    const result = await this.pool.query<ProviderCredentialRow>(
      `SELECT * FROM provider_credentials
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return result.rows[0] ? providerCredentialFromRow(result.rows[0]) : null;
  }

  async updateProviderCredential(
    workspaceId: string,
    id: string,
    patch: UpdateProviderCredentialRecord,
  ): Promise<ProviderCredentialRecord | null> {
    const assignments: string[] = [];
    const values: unknown[] = [id, workspaceId];
    const add = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (patch.name !== undefined) add("name", patch.name);
    if (patch.ciphertext !== undefined) add("ciphertext", patch.ciphertext);
    if (patch.ciphertextIv !== undefined) add("ciphertext_iv", patch.ciphertextIv);
    if (patch.ciphertextTag !== undefined) add("ciphertext_tag", patch.ciphertextTag);
    if (patch.wrappedKey !== undefined) add("wrapped_key", patch.wrappedKey);
    if (patch.wrappedKeyIv !== undefined) add("wrapped_key_iv", patch.wrappedKeyIv);
    if (patch.wrappedKeyTag !== undefined) add("wrapped_key_tag", patch.wrappedKeyTag);
    if (patch.keyVersion !== undefined) add("key_version", patch.keyVersion);
    if (patch.maskedValue !== undefined) add("masked_value", patch.maskedValue);
    if (patch.modelFilters !== undefined) add("model_filters", patch.modelFilters);
    if (patch.priority !== undefined) add("priority", patch.priority);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.rotatedAt !== undefined) add("rotated_at", patch.rotatedAt);
    if (!assignments.length) return this.findProviderCredential(workspaceId, id);

    const result = await this.pool.query<ProviderCredentialRow>(
      `UPDATE provider_credentials
       SET ${assignments.join(", ")}, updated_at = now()
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      values,
    );
    return result.rows[0] ? providerCredentialFromRow(result.rows[0]) : null;
  }

  async deleteProviderCredential(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM provider_credentials WHERE id = $1 AND workspace_id = $2",
      [id, workspaceId],
    );
    return result.rowCount === 1;
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
    const result = await this.pool.query<ProviderCredentialRow>(
      `UPDATE provider_credentials
       SET status = $3,
           last_verified_at = $4,
           last_verification_error = $5,
           updated_at = now()
       WHERE id = $1
         AND workspace_id = $2
         AND ($6::text IS NULL OR ciphertext = $6)
       RETURNING *`,
      [id, workspaceId, input.status, input.verifiedAt, input.error, input.expectedCiphertext ?? null],
    );
    return result.rows[0] ? providerCredentialFromRow(result.rows[0]) : null;
  }

  async createGeneration(input: CreateGenerationRecord): Promise<GenerationRecord> {
    const result = await this.pool.query<GenerationRow>(
      `INSERT INTO generations (
        id, workspace_id, api_key_id, request_id, requested_model, request_started_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [input.id, input.workspaceId, input.apiKeyId, input.requestId, input.requestedModel, input.requestStartedAt],
    );
    return generationFromRow(result.rows[0]);
  }

  async markGenerationFirstToken(workspaceId: string, id: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE generations
       SET first_token_at = COALESCE(first_token_at, $3)
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
      [id, workspaceId, at],
    );
  }

  async finalizeGeneration(
    workspaceId: string,
    id: string,
    input: FinalizeGenerationRecord,
  ): Promise<GenerationRecord | null> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<GenerationRow>(
        `UPDATE generations
         SET status = $3,
             resolved_model = $4,
             prompt_tokens = $5,
             completion_tokens = $6,
             total_tokens = $7,
             usage_estimated = $8,
             error_code = $9,
             completed_at = $10
         WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
         RETURNING *`,
        [
          id,
          workspaceId,
          input.status,
          input.resolvedModel,
          input.usage?.prompt_tokens ?? null,
          input.usage?.completion_tokens ?? null,
          input.usage?.total_tokens ?? null,
          input.usage ? input.usage.estimated === true : null,
          input.errorCode ?? null,
          input.completedAt,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (input.status === "succeeded" && input.usage) {
        await client.query(
          `INSERT INTO usage_ledger (generation_id, workspace_id, dimension, quantity, estimated, created_at)
           VALUES
             ($1, $2, 'prompt_tokens', $3, $6, $7),
             ($1, $2, 'completion_tokens', $4, $6, $7),
             ($1, $2, 'total_tokens', $5, $6, $7)
           ON CONFLICT (generation_id, dimension) DO NOTHING`,
          [
            id,
            workspaceId,
            input.usage.prompt_tokens,
            input.usage.completion_tokens,
            input.usage.total_tokens,
            input.usage.estimated === true,
            input.completedAt,
          ],
        );
      }
      return generationFromRow(row);
    });
  }

  async findGeneration(workspaceId: string, id: string): Promise<GenerationRecord | null> {
    const result = await this.pool.query<GenerationRow>(
      "SELECT * FROM generations WHERE id = $1 AND workspace_id = $2",
      [id, workspaceId],
    );
    return result.rows[0] ? generationFromRow(result.rows[0]) : null;
  }

  async findGenerationByRequestId(workspaceId: string, requestId: string): Promise<GenerationRecord | null> {
    const result = await this.pool.query<GenerationRow>(
      `SELECT * FROM generations
       WHERE workspace_id = $1 AND request_id = $2
       ORDER BY request_started_at DESC, id DESC
       LIMIT 1`,
      [workspaceId, requestId],
    );
    return result.rows[0] ? generationFromRow(result.rows[0]) : null;
  }

  async listGenerationSummaries(workspaceId: string, limit: number): Promise<GenerationSummaryRecord[]> {
    const result = await this.pool.query<GenerationSummaryRow>(
      `SELECT g.id,
              g.api_key_id,
              g.request_id,
              g.requested_model,
              g.resolved_model,
              attempt.endpoint_id AS provider_endpoint_id
              , g.status
              , g.prompt_tokens
              , g.completion_tokens
              , g.total_tokens
              , g.usage_estimated
              , g.request_started_at
              , g.first_token_at
              , g.completed_at
       FROM generations g
       LEFT JOIN LATERAL (
         SELECT pa.endpoint_id
         FROM provider_attempts pa
         WHERE pa.workspace_id = g.workspace_id
           AND pa.generation_id = g.id
         ORDER BY (pa.status = 'succeeded') DESC, pa.started_at DESC, pa.id DESC
         LIMIT 1
       ) attempt ON true
       WHERE g.workspace_id = $1
       ORDER BY g.request_started_at DESC, g.id DESC
       LIMIT $2`,
      [workspaceId, Math.max(1, Math.min(limit, 200))],
    );
    return result.rows.map(generationSummaryFromRow);
  }

  async getUsageSummary(workspaceId: string): Promise<UsageSummaryRecord> {
    const result = await this.pool.query<UsageSummaryRow>(
      `WITH generation_counts AS (
         SELECT COUNT(*)::bigint AS generations_total,
                COUNT(*) FILTER (WHERE status = 'succeeded')::bigint AS generations_succeeded,
                COUNT(*) FILTER (WHERE status = 'failed')::bigint AS generations_failed,
                COUNT(*) FILTER (WHERE status = 'cancelled')::bigint AS generations_cancelled,
                COUNT(*) FILTER (WHERE status = 'pending')::bigint AS generations_pending
         FROM generations
         WHERE workspace_id = $1
       ), ledger_totals AS (
         SELECT COALESCE(SUM(quantity) FILTER (WHERE dimension = 'prompt_tokens'), 0)::bigint AS prompt_tokens,
                COALESCE(SUM(quantity) FILTER (WHERE dimension = 'completion_tokens'), 0)::bigint AS completion_tokens,
                COALESCE(SUM(quantity) FILTER (WHERE dimension = 'total_tokens'), 0)::bigint AS total_tokens,
                COUNT(DISTINCT generation_id) FILTER (WHERE estimated IS TRUE)::bigint AS estimated_generations
         FROM usage_ledger
         WHERE workspace_id = $1
       )
       SELECT * FROM ledger_totals CROSS JOIN generation_counts`,
      [workspaceId],
    );
    const row = result.rows[0];
    return {
      totals: {
        promptTokens: safeInteger(row.prompt_tokens, "Prompt token total"),
        completionTokens: safeInteger(row.completion_tokens, "Completion token total"),
        totalTokens: safeInteger(row.total_tokens, "Token total"),
      },
      generations: {
        total: safeInteger(row.generations_total, "Generation count"),
        succeeded: safeInteger(row.generations_succeeded, "Succeeded generation count"),
        failed: safeInteger(row.generations_failed, "Failed generation count"),
        cancelled: safeInteger(row.generations_cancelled, "Cancelled generation count"),
        pending: safeInteger(row.generations_pending, "Pending generation count"),
      },
      estimatedGenerations: safeInteger(row.estimated_generations, "Estimated generation count"),
    };
  }

  async createProviderAttempt(input: CreateProviderAttemptRecord): Promise<ProviderAttemptRecord> {
    const result = await this.pool.query<ProviderAttemptRow>(
      `INSERT INTO provider_attempts (
        id, generation_id, workspace_id, provider_id, endpoint_id, credential_id, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        input.id,
        input.generationId,
        input.workspaceId,
        input.providerId,
        input.endpointId,
        input.credentialId,
        input.startedAt,
      ],
    );
    return providerAttemptFromRow(result.rows[0]);
  }

  async markProviderAttemptFirstToken(workspaceId: string, id: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE provider_attempts
       SET first_token_at = COALESCE(first_token_at, $3)
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
      [id, workspaceId, at],
    );
  }

  async finalizeProviderAttempt(
    workspaceId: string,
    id: string,
    input: FinalizeProviderAttemptRecord,
  ): Promise<ProviderAttemptRecord | null> {
    const result = await this.pool.query<ProviderAttemptRow>(
      `UPDATE provider_attempts
       SET status = $3,
           prompt_tokens = $4,
           completion_tokens = $5,
           total_tokens = $6,
           usage_estimated = $7,
           error_code = $8,
           completed_at = $9
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
       RETURNING *`,
      [
        id,
        workspaceId,
        input.status,
        input.usage?.prompt_tokens ?? null,
        input.usage?.completion_tokens ?? null,
        input.usage?.total_tokens ?? null,
        input.usage ? input.usage.estimated === true : null,
        input.errorCode ?? null,
        input.completedAt,
      ],
    );
    return result.rows[0] ? providerAttemptFromRow(result.rows[0]) : null;
  }

  async listProviderAttempts(workspaceId: string, generationId: string): Promise<ProviderAttemptRecord[]> {
    const result = await this.pool.query<ProviderAttemptRow>(
      `SELECT * FROM provider_attempts
       WHERE workspace_id = $1 AND generation_id = $2
       ORDER BY started_at, id`,
      [workspaceId, generationId],
    );
    return result.rows.map(providerAttemptFromRow);
  }

  async listUsageLedger(workspaceId: string, generationId: string): Promise<UsageLedgerRecord[]> {
    const result = await this.pool.query<UsageLedgerRow>(
      `SELECT * FROM usage_ledger
       WHERE workspace_id = $1 AND generation_id = $2
       ORDER BY dimension`,
      [workspaceId, generationId],
    );
    return result.rows.map(usageLedgerFromRow);
  }

  async appendAuditEvent(input: AppendAuditEventRecord): Promise<AuditEventRecord> {
    const result = await this.pool.query<AuditEventRow>(
      `INSERT INTO audit_events (
        id, event_key, workspace_id, actor_type, actor_id, action,
        resource_type, resource_id, request_id, outcome, metadata, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (event_key) DO NOTHING
      RETURNING *`,
      [
        input.id,
        input.eventKey,
        input.workspaceId,
        input.actorType,
        input.actorId,
        input.action,
        input.resourceType,
        input.resourceId,
        input.requestId,
        input.outcome,
        input.metadata,
        input.occurredAt,
      ],
    );
    if (result.rows[0]) return auditEventFromRow(result.rows[0]);
    const existing = await this.pool.query<AuditEventRow>(
      "SELECT * FROM audit_events WHERE event_key = $1",
      [input.eventKey],
    );
    if (!existing.rows[0]) throw new Error("Audit event conflict could not be resolved.");
    return auditEventFromRow(existing.rows[0]);
  }

  async listAuditEvents(workspaceId: string, limit = 100): Promise<AuditEventRecord[]> {
    const result = await this.pool.query<AuditEventRow>(
      `SELECT * FROM audit_events
       WHERE workspace_id = $1
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2`,
      [workspaceId, Math.max(1, Math.min(limit, 1_000))],
    );
    return result.rows.map(auditEventFromRow);
  }

  async reconcileStaleGenerations(cutoff: Date, completedAt: Date): Promise<ReconciliationResult> {
    return transaction(this.pool, async (client) => {
      const reservations = await client.query(
        `UPDATE admission_reservations ar
         SET status = 'released', completed_at = $2
         FROM generations g
         WHERE ar.generation_id = g.id
           AND ar.status = 'active'
           AND (
             ar.created_at < $1
             OR g.status <> 'pending'
             OR (g.status = 'pending' AND g.request_started_at < $1)
           )`,
        [cutoff, completedAt],
      );
      const attempts = await client.query(
        `UPDATE provider_attempts pa
         SET status = 'failed', error_code = 'reconciliation_timeout', completed_at = $2
         FROM generations g
         WHERE pa.generation_id = g.id
           AND pa.status = 'pending'
           AND (pa.started_at < $1 OR (g.status = 'pending' AND g.request_started_at < $1))`,
        [cutoff, completedAt],
      );
      const generations = await client.query(
        `UPDATE generations
         SET status = 'failed', error_code = 'reconciliation_timeout', completed_at = $2
         WHERE status = 'pending' AND request_started_at < $1`,
        [cutoff, completedAt],
      );
      return {
        generationsFinalized: generations.rowCount ?? 0,
        attemptsFinalized: attempts.rowCount ?? 0,
        reservationsReleased: reservations.rowCount ?? 0,
      };
    });
  }
}

export function createPostgresPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}