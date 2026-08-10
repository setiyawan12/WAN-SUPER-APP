import { randomUUID } from "node:crypto";
import { GatewayError } from "../errors.js";
import type {
  AdmissionPolicy,
  AdmissionRequest,
  AdmissionReservation,
  AdmissionStore,
} from "./limits.js";

interface StoredReservation extends AdmissionReservation {
  status: "active" | "settled" | "released";
  minuteBucket: string;
  dayBucket: string;
  actualTokens: number | null;
  actualCostMicros: bigint | null;
}

function minuteBucket(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function dayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class InMemoryAdmissionStore implements AdmissionStore {
  private readonly reservations = new Map<string, StoredReservation>();
  private readonly locks = new Map<string, Promise<void>>();

  async reserve(policy: AdmissionPolicy, request: AdmissionRequest): Promise<AdmissionReservation> {
    const scope = request.workspaceId;
    return this.exclusive(scope, async () => {
      const minute = minuteBucket(request.now);
      const day = dayBucket(request.now);
      const scoped = [...this.reservations.values()].filter((reservation) => (
        reservation.workspaceId === request.workspaceId
      ));
      const requestsThisMinute = scoped.filter((reservation) => (
        reservation.credentialId === request.credentialId && reservation.minuteBucket === minute
      )).length;
      if (requestsThisMinute >= policy.requestsPerMinute) {
        throw new GatewayError(429, "rate_limit_error", "rate_limit_exceeded", "The request rate limit was reached.");
      }
      const active = scoped.filter((reservation) => reservation.status === "active").length;
      if (active >= policy.maxConcurrent) {
        throw new GatewayError(429, "rate_limit_error", "concurrency_limit_exceeded", "The concurrent request limit was reached.");
      }
      const dayReservations = scoped.filter((reservation) => reservation.dayBucket === day && reservation.status !== "released");
      const tokenCommitment = dayReservations.reduce((total, reservation) => (
        total + (reservation.status === "settled" ? reservation.actualTokens! : reservation.reservedTokens)
      ), 0);
      if (tokenCommitment + request.requestedTokens > policy.dailyTokenLimit) {
        throw new GatewayError(429, "rate_limit_error", "token_quota_exceeded", "The daily token quota was reached.");
      }
      if (policy.dailyBudgetMicros !== undefined) {
        const costCommitment = dayReservations.reduce((total, reservation) => (
          total + (reservation.status === "settled" ? reservation.actualCostMicros! : reservation.reservedCostMicros)
        ), 0n);
        if (costCommitment + request.reservedCostMicros > policy.dailyBudgetMicros) {
          throw new GatewayError(429, "rate_limit_error", "budget_exceeded", "The daily budget was reached.");
        }
      }

      const stored: StoredReservation = {
        id: randomUUID(),
        workspaceId: request.workspaceId,
        credentialId: request.credentialId,
        generationId: request.generationId,
        reservedTokens: request.requestedTokens,
        reservedCostMicros: request.reservedCostMicros,
        status: "active",
        minuteBucket: minute,
        dayBucket: day,
        actualTokens: null,
        actualCostMicros: null,
      };
      this.reservations.set(stored.id, stored);
      return { ...stored };
    });
  }

  async settle(reservationId: string, actualTokens: number, actualCostMicros: bigint): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    await this.exclusive(reservation.workspaceId, async () => {
      if (reservation.status !== "active") return;
      reservation.status = "settled";
      reservation.actualTokens = actualTokens;
      reservation.actualCostMicros = actualCostMicros;
    });
  }

  async release(reservationId: string): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    await this.exclusive(reservation.workspaceId, async () => {
      if (reservation.status !== "active") return;
      reservation.status = "released";
    });
  }

  private async exclusive<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scope) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(scope, queued);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.locks.get(scope) === queued) this.locks.delete(scope);
    }
  }
}