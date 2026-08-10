import { createPostgresPool, PostgresRouterRepository } from "./postgres.js";
import { GenerationService } from "../inference/generations.js";

const databaseUrl = process.env.WAN_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("WAN_DATABASE_URL is required.");
const staleAfterMs = Number(process.env.WAN_RECONCILE_STALE_MS || 5 * 60_000);
if (!Number.isInteger(staleAfterMs) || staleAfterMs < 60_000 || staleAfterMs > 24 * 60 * 60_000) {
  throw new Error("WAN_RECONCILE_STALE_MS must be an integer between 60000 and 86400000.");
}

const pool = createPostgresPool(databaseUrl);
try {
  const completedAt = new Date();
  const cutoff = new Date(completedAt.getTime() - staleAfterMs);
  const result = await new GenerationService(new PostgresRouterRepository(pool)).reconcileStale(cutoff, completedAt);
  console.log(JSON.stringify({ severity: "INFO", message: "generation_reconciliation_completed", ...result }));
} finally {
  await pool.end();
}