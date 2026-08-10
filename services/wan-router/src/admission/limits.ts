import { GatewayError } from "../errors.js";

export interface AdmissionPolicy {
  requestsPerMinute: number;
  maxConcurrent: number;
  maxTokensPerRequest: number;
  dailyTokenLimit: number;
  dailyBudgetMicros?: bigint;
}

export interface AdmissionRequest {
  workspaceId: string;
  credentialId: string;
  generationId: string;
  requestedTokens: number;
  reservedCostMicros: bigint;
  now: Date;
}

export interface AdmissionReservation {
  id: string;
  workspaceId: string;
  credentialId: string;
  generationId: string;
  reservedTokens: number;
  reservedCostMicros: bigint;
}

export interface AdmissionStore {
  reserve(policy: AdmissionPolicy, request: AdmissionRequest): Promise<AdmissionReservation>;
  settle(reservationId: string, actualTokens: number, actualCostMicros: bigint, completedAt: Date): Promise<void>;
  release(reservationId: string, completedAt: Date): Promise<void>;
}

function validatePolicy(policy: AdmissionPolicy): void {
  for (const [name, value] of Object.entries({
    requestsPerMinute: policy.requestsPerMinute,
    maxConcurrent: policy.maxConcurrent,
    maxTokensPerRequest: policy.maxTokensPerRequest,
    dailyTokenLimit: policy.dailyTokenLimit,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  }
  if (policy.dailyBudgetMicros !== undefined && policy.dailyBudgetMicros < 0n) {
    throw new Error("dailyBudgetMicros cannot be negative.");
  }
}

function validateRequest(request: AdmissionRequest): void {
  if (!request.workspaceId || !request.credentialId || !request.generationId) {
    throw new Error("Admission request identity is required.");
  }
  if (!Number.isInteger(request.requestedTokens) || request.requestedTokens < 1) {
    throw new Error("Admission requestedTokens must be a positive integer.");
  }
  if (request.reservedCostMicros < 0n) throw new Error("Admission reservedCostMicros cannot be negative.");
}

export class AdmissionService {
  constructor(
    private readonly store: AdmissionStore,
    private readonly policy: AdmissionPolicy,
  ) {
    validatePolicy(policy);
  }

  async reserve(request: AdmissionRequest): Promise<AdmissionReservation> {
    validateRequest(request);
    if (request.requestedTokens > this.policy.maxTokensPerRequest) {
      throw new GatewayError(429, "rate_limit_error", "token_quota_exceeded", "The request exceeds the token limit.");
    }
    return this.store.reserve(this.policy, request);
  }

  settle(
    reservationId: string,
    actualTokens: number,
    actualCostMicros: bigint,
    completedAt = new Date(),
  ): Promise<void> {
    if (!Number.isInteger(actualTokens) || actualTokens < 0) throw new Error("actualTokens must be a non-negative integer.");
    if (actualCostMicros < 0n) throw new Error("actualCostMicros cannot be negative.");
    return this.store.settle(reservationId, actualTokens, actualCostMicros, completedAt);
  }

  release(reservationId: string, completedAt = new Date()): Promise<void> {
    return this.store.release(reservationId, completedAt);
  }
}