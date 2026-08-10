import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { GatewayError } from "../errors.js";
import type {
  AdmissionPolicy,
  AdmissionRequest,
  AdmissionReservation,
  AdmissionStore,
} from "./limits.js";

interface AdmissionAggregateRow {
  requests_this_minute: string;
  active_count: string;
  token_commitment: string;
  cost_commitment: string;
}

export class PostgresAdmissionStore implements AdmissionStore {
  constructor(private readonly pool: Pool) {}

  async reserve(policy: AdmissionPolicy, request: AdmissionRequest): Promise<AdmissionReservation> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [request.workspaceId],
      );
      const aggregate = await client.query<AdmissionAggregateRow>(
        `SELECT
           count(*) FILTER (
             WHERE credential_id = $2 AND minute_bucket = date_trunc('minute', $3::timestamptz)
           )::text AS requests_this_minute,
           count(*) FILTER (WHERE status = 'active')::text AS active_count,
           COALESCE(sum(
             CASE
               WHEN day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date AND status = 'settled' THEN actual_tokens
               WHEN day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date AND status = 'active' THEN reserved_tokens
               ELSE 0
             END
           ), 0)::text AS token_commitment,
           COALESCE(sum(
             CASE
               WHEN day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date AND status = 'settled' THEN actual_cost_micros
               WHEN day_bucket = ($3::timestamptz AT TIME ZONE 'UTC')::date AND status = 'active' THEN reserved_cost_micros
               ELSE 0
             END
           ), 0)::text AS cost_commitment
         FROM admission_reservations
           WHERE workspace_id = $1`,
        [request.workspaceId, request.credentialId, request.now],
      );
      const counters = aggregate.rows[0];
      if (Number(counters.requests_this_minute) >= policy.requestsPerMinute) {
        throw new GatewayError(429, "rate_limit_error", "rate_limit_exceeded", "The request rate limit was reached.");
      }
      if (Number(counters.active_count) >= policy.maxConcurrent) {
        throw new GatewayError(429, "rate_limit_error", "concurrency_limit_exceeded", "The concurrent request limit was reached.");
      }
      if (Number(counters.token_commitment) + request.requestedTokens > policy.dailyTokenLimit) {
        throw new GatewayError(429, "rate_limit_error", "token_quota_exceeded", "The daily token quota was reached.");
      }
      if (
        policy.dailyBudgetMicros !== undefined
        && BigInt(counters.cost_commitment) + request.reservedCostMicros > policy.dailyBudgetMicros
      ) {
        throw new GatewayError(429, "rate_limit_error", "budget_exceeded", "The daily budget was reached.");
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO admission_reservations (
          id, workspace_id, credential_id, generation_id,
          minute_bucket, day_bucket, reserved_tokens, reserved_cost_micros, created_at
        ) VALUES (
          $1, $2, $3, $4,
          date_trunc('minute', $5::timestamptz),
          ($5::timestamptz AT TIME ZONE 'UTC')::date,
          $6, $7, $5
        )`,
        [
          id,
          request.workspaceId,
          request.credentialId,
          request.generationId,
          request.now,
          request.requestedTokens,
          request.reservedCostMicros.toString(),
        ],
      );
      await client.query("COMMIT");
      return {
        id,
        workspaceId: request.workspaceId,
        credentialId: request.credentialId,
        generationId: request.generationId,
        reservedTokens: request.requestedTokens,
        reservedCostMicros: request.reservedCostMicros,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async settle(reservationId: string, actualTokens: number, actualCostMicros: bigint, completedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE admission_reservations
       SET status = 'settled', actual_tokens = $2, actual_cost_micros = $3, completed_at = $4
       WHERE id = $1 AND status = 'active'`,
      [reservationId, actualTokens, actualCostMicros.toString(), completedAt],
    );
  }

  async release(reservationId: string, completedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE admission_reservations
       SET status = 'released', completed_at = $2
       WHERE id = $1 AND status = 'active'`,
      [reservationId, completedAt],
    );
  }
}