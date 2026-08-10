# WAN Router Observability Runbook

Owner groups:

- `wan-router-oncall`: availability, provider, database, capacity, and cost controls;
- `wan-router-security`: authentication anomalies, KMS, audit, and secret incidents.

Production notification channels and credentials are managed outside this
repository. Every alert must point to a tested section below before activation.

## Deploy And Rollback

1. Set `WAN_METRICS_BEARER_TOKEN` from Secret Manager with at least 32 random bytes.
2. Restrict `/metrics` to the collector identity/network; WAN API keys are rejected.
3. Apply database migration `006_audit_events.sql` before the new revision.
4. Deploy the revision and verify `/healthz`, authenticated `/metrics`, one chat,
   one `generation_finalized` log, and one tenant audit event.
5. Apply `ops/cloud-monitoring` with an existing notification channel.
6. Verify one synthetic page alert reaches its owner, then resolve it.

Rollback the application revision first. Migration `006` is backward compatible;
leave `audit_events` in place. Remove monitoring policies only after the old
revision is stable. Do not delete audit evidence during an incident.

Before staging deployment, run `WAN_TEST_DATABASE_URL=<disposable-db-url> npm
run migration:rehearse`. The repository rehearsal applies the pre-`006` schema,
seeds its application contract, applies all forward migrations, proves that the
pre-audit contract still reads and writes after `006`, checks audit immutability,
and reruns the migrator idempotently in an isolated schema. It is not a backup,
restore, Cloud SQL failover, or staging revision rollback rehearsal.

Run `WAN_TEST_DATABASE_URL=<disposable-admin-db-url> npm run backup:rehearse`
before staging release. It creates two temporary databases, produces a
custom-format PostgreSQL 17 logical dump, restores it transactionally, verifies
tenant/key/credential/generation/usage/reservation/audit data, foreign keys, the
immutable audit trigger, and post-restore migration idempotency, then drops both
databases. Cloud SQL point-in-time recovery, backup retention, IAM, regional
failover, and restore-time objectives still require `OPS-01` staging rehearsal.

For controlled retention/account deletion, use a migration-owner transaction:
take an exclusive table lock, disable `audit_events_immutable_write`, perform a
tenant/cutoff-scoped delete, re-enable the trigger, and commit. Runtime service
roles must not own the table or receive trigger-alter privileges.

## High Error Rate

1. Check deployment revision, 5xx codes, database health, and provider attempts.
2. Stop canary traffic if the newest revision correlates with the spike.
3. Roll back the revision; do not retry streams after first output.

## Provider Failure Spike

1. Group attempts by provider/status/error code.
2. Confirm upstream status and circuit state.
3. Disable only the affected candidate or allow configured fallback.

## Provider Rate Limit

1. Confirm `provider_rate_limited` attempt rate and affected provider.
2. Reduce admission/concurrency or route to an allowed fallback.
3. Do not bypass workspace budgets or privacy policy.

## Budget Rejection

1. Confirm the hard block is expected for the workspace policy.
2. Investigate compromised keys or unexpected model usage.
3. Never increase budget solely to silence the alert.

## KMS Failure

1. Page `wan-router-security` immediately.
2. Verify key version state, IAM, region, and CRC32C/integrity errors.
3. Disable direct-provider BYOK if decrypt is unreliable; never fall back to a
   local master key in KMS mode.

## Database Unavailable

1. Check Cloud SQL health, connector/IAM, connection exhaustion, and network path.
2. Stop new admission if persistence cannot be guaranteed.
3. Reconcile pending generation/reservation state after recovery.

## Database Pool Saturation

1. Check instance count multiplied by pool maximum.
2. Identify slow transactions and waiting clients.
3. Reduce Cloud Run concurrency or pool size before scaling instances further.

## Stale Generations

1. Run `npm run reconcile` with the production database secret through the
   scheduled job identity.
2. Verify pending generations, attempts, and reservations return to zero.
3. Investigate instance termination or finalization persistence errors.

## Authorization Denial Spike

1. Group normalized codes (`invalid_api_key`, `insufficient_scope`, tenant denial).
2. Identify compromised/revoked keys without logging the key value.
3. Revoke affected credentials and preserve audit evidence.

## Audit Pipeline Failure

1. Page `wan-router-security`; audit failure must never be treated as silent success.
2. Check PostgreSQL health, migration presence, permissions, and immutable trigger.
3. Preserve structured logs and request IDs for reconciliation.
4. Stop sensitive control-plane changes if persistence remains unavailable.

## Circuit Open

1. Confirm the candidate and preceding normalized failures.
2. Check upstream health and cooldown recovery.
3. Do not force-close a circuit while the endpoint is still failing.

## Secret Scanner Match

1. Stop release/deployment.
2. Rotate the credential before removing it from source/history/log sinks.
3. Record the incident without copying the secret into tickets or chat.
4. Run `npm run security:scan` and repository history scanning before release.

## Local Rehearsal

```sh
export WAN_METRICS_BEARER_TOKEN="$(openssl rand -hex 32)"
token_file="$(mktemp)"
printf '%s' "$WAN_METRICS_BEARER_TOKEN" > "$token_file"

WAN_METRICS_TOKEN_FILE="$token_file" npm run ops:up
# Prometheus:   http://127.0.0.1:59090
# Alertmanager: http://127.0.0.1:59093
# Grafana:      http://127.0.0.1:53000

WAN_METRICS_TOKEN_FILE="$token_file" npm run ops:down
rm -f "$token_file"
```

Run the application on host port `8080` with the same
`WAN_METRICS_BEARER_TOKEN`; Prometheus scrapes it through
`host.docker.internal`.