# WAN Router

Development gateway for the WAN Router Cloud data-plane contract.

Current scope:

- Firebase ID-token authentication or development-only static Bearer authentication;
- PostgreSQL users, personal workspaces, memberships, and WAN API-key storage;
- WAN API-key create/list/revoke/verify with one-time plaintext and HMAC digest;
- provider credential create/list/update/verify/delete with ciphertext-only
	storage and tenant-scoped control-plane access;
- per-record envelope encryption using a development-local master key or Google
	Cloud KMS with context-bound AAD, CRC32C integrity checks, and key-version
	tracking;
- deterministic mock provider;
- primary live path through a configured remote CLIProxyAPI domain using
	a server-side proxy API key;
- opt-in official OpenAI Chat Completions adapter retained as an additional
	direct-provider option using tenant BYOK credentials;
- canonical `openai/gpt-4.1` and `openai/gpt-4.1-mini` model IDs with explicit
	status, owner, capabilities, and upstream mapping;
- fixed-priority routing, transient pre-output fallback, BYOK credential
	fallback, and an in-memory provider circuit breaker;
- PostgreSQL generation, provider-attempt, first-token, token-ledger, and stale
	pending reconciliation records;
- atomic PostgreSQL request-rate, workspace concurrency, daily token quota, and
	optional integer micro-USD budget reservations;
- `GET /v1/models`;
- streaming and non-streaming `POST /v1/chat/completions`;
- request IDs, validation, cancellation, structured metadata logs, and normalized errors.
- authenticated bounded-label Prometheus metrics, immutable tenant audit events,
  secret scanning, tested alerts, and provisioned Grafana/Cloud Monitoring resources.

It is not production-ready. `CliproxyRemoteAdapter` and its local HTTP fixture
are implemented, and direct OpenAI remains an explicit optional mode. Production
membership workflows, Secret Manager ownership of API-key pepper and the remote
CLIProxyAPI proxy key, least-privilege KMS IAM, live KMS integration tests,
rotation/runbooks, Redis multi-instance limits, remote CLIProxyAPI and optional
OpenAI staging verification, persisted routing/circuit policy, immutable provider
pricing, and production deployment/notification-channel activation remain gated
follow-up work.

## Local PostgreSQL

```sh
docker compose up -d --wait

export WAN_DATABASE_URL='postgres://wan_router:wan_router_dev@127.0.0.1:55432/wan_router'
npm run migrate

WAN_TEST_DATABASE_URL="$WAN_DATABASE_URL" npm run test:postgres
```

Migrations are a separate job. The gateway never mutates schema at startup.

Rehearse forward migration and application-revision rollback compatibility in
an isolated temporary schema:

```sh
WAN_TEST_DATABASE_URL="$WAN_DATABASE_URL" npm run migration:rehearse
```

This applies the pre-audit schema, seeds its application contract, runs the
current migrator, verifies the old contract still works after `006`, verifies
audit immutability, reruns migrations idempotently, and drops the temporary
schema. It intentionally does not perform destructive down migrations.

Rehearse a logical backup and restore with two disposable databases:

```sh
WAN_TEST_DATABASE_URL="$WAN_DATABASE_URL" npm run backup:rehearse
```

The rehearsal uses PostgreSQL 17 `pg_dump`/`pg_restore` in a pinned container,
restores core tenant, key, encrypted-credential, generation, usage, reservation,
and audit data, verifies foreign-key and immutable-audit behavior, reruns the
migrator, and drops both databases. It is not a Cloud SQL point-in-time recovery
or regional failover rehearsal.

Run the same repository gate used by CI with a disposable PostgreSQL database:

```sh
WAN_TEST_DATABASE_URL="$WAN_DATABASE_URL" npm run qa:verify
```

The gate requires PostgreSQL, builds once, migrates the test database, rehearses
forward/application rollback compatibility and logical backup/restore, runs all
tests without skips, scans secrets, validates the observability stack and
Terraform, rehearses Prometheus alerts, and rejects High/Critical production
dependency findings. Non-loopback databases require the explicit
`WAN_QA_ALLOW_REMOTE_DATABASE=true` operator opt-in; production environments are
always rejected.

Run stale generation/attempt/reservation reconciliation as a separate scheduled
job. The default cutoff is five minutes:

```sh
WAN_DATABASE_URL="$WAN_DATABASE_URL" npm run reconcile
# Optional: WAN_RECONCILE_STALE_MS=300000
```

```sh
npm install
npm test
export WAN_LOCAL_ENVELOPE_KEY="$(openssl rand -base64 32)"
WAN_ENV=dev \
WAN_AUTH_MODE=dev-static \
WAN_ENVELOPE_MODE=local \
WAN_DEV_API_KEY=wan_sk_dev_example_secret \
WAN_DATABASE_URL='postgres://wan_router:wan_router_dev@127.0.0.1:55432/wan_router' \
WAN_API_KEY_PEPPER='replace-with-at-least-32-random-bytes' \
WAN_CORS_ORIGINS=http://127.0.0.1:5178 \
npm start
```

For the browser runtime, use Firebase Authentication instead:

```sh
export WAN_LOCAL_ENVELOPE_KEY="$(openssl rand -base64 32)"
WAN_ENV=dev \
WAN_AUTH_MODE=firebase \
WAN_ENVELOPE_MODE=local \
WAN_FIREBASE_PROJECT_ID=demo-wan-super-app \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
WAN_DATABASE_URL='postgres://wan_router:wan_router_dev@127.0.0.1:55432/wan_router' \
WAN_API_KEY_PEPPER='replace-with-at-least-32-random-bytes' \
WAN_CORS_ORIGINS=http://127.0.0.1:5178 \
npm start
```

Keep the same local envelope key across restarts or existing development
credentials cannot be decrypted. Never use local envelope mode for a public
deployment.

For the Cloud KMS code path, use Application Default Credentials and pass the
CryptoKey resource, not a specific CryptoKeyVersion:

```sh
WAN_ENVELOPE_MODE=gcp-kms \
WAN_KMS_CRYPTO_KEY='projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/provider-credentials' \
WAN_ENV=dev \
WAN_AUTH_MODE=firebase \
WAN_FIREBASE_PROJECT_ID='wan-project' \
WAN_DATABASE_URL='postgres://wan_router:wan_router_dev@127.0.0.1:55432/wan_router' \
WAN_API_KEY_PEPPER='replace-with-at-least-32-random-bytes' \
WAN_CORS_ORIGINS='https://router.example.com' \
npm start
```

The runtime service account needs `cloudkms.cryptoKeyVersions.useToEncrypt` and
`cloudkms.cryptoKeyVersions.useToDecrypt` on that key. Prefer a key-scoped
`roles/cloudkms.cryptoKeyEncrypterDecrypter` binding. The code stores the exact
primary version returned by encryption and uses the CryptoKey for decrypt, so
credentials encrypted before a primary-version rotation remain readable while
that version stays enabled.

The development server binds to `127.0.0.1` by default. It never imports or
publishes the desktop Cliproxy backend.

## Remote CLIProxyAPI mode

The primary live architecture is:

```text
client -> WAN Router -> CliproxyRemoteAdapter -> configured CLIProxyAPI domain
```

The client authenticates to WAN Router with a WAN API key or Firebase token.
WAN Router authenticates separately to CLIProxyAPI with its server-side proxy
API key. The two credentials must never be substituted for or forwarded as one
another.

Runtime configuration:

```sh
WAN_PROVIDER_MODE=cliproxy \
WAN_CLIPROXY_BASE_URL='https://cliproxy.example.com/v1' \
WAN_CLIPROXY_API_KEY='<Secret Manager injected proxy API key>' \
WAN_PROVIDER_TIMEOUT_MS=60000 \
npm start
```

`GET /v1/models` is discovered live from CLIProxyAPI. Model IDs are returned and
forwarded verbatim to `POST /v1/chat/completions`; provider selection and OAuth
accounts behind those model IDs remain owned by CLIProxyAPI. Production requires
HTTPS. Loopback HTTP is reserved for development and tests.

This mode is implemented locally. Its fixtures verify live model discovery,
model-ID pass-through, stream/non-stream chat, final usage, cancellation,
attempt records, URL restrictions, and separation of WAN credentials from the
CLIProxyAPI proxy key. Use `mock` for deterministic development; direct OpenAI
must not be treated as the primary production path.

## Optional OpenAI provider development mode

The runtime defaults to the deterministic mock provider. The official OpenAI
adapter remains available as an explicit additional provider path. To exercise
it during development, add these variables to the Firebase-authenticated startup
configuration:

```sh
WAN_PROVIDER_MODE=openai \
WAN_PROVIDER_TIMEOUT_MS=60000 \
WAN_PROVIDER_CIRCUIT_FAILURE_THRESHOLD=3 \
WAN_PROVIDER_CIRCUIT_COOLDOWN_MS=30000 \
WAN_ENV=dev \
WAN_AUTH_MODE=firebase \
WAN_ENVELOPE_MODE=local \
WAN_LOCAL_ENVELOPE_KEY="$WAN_LOCAL_ENVELOPE_KEY" \
WAN_FIREBASE_PROJECT_ID=demo-wan-super-app \
WAN_DATABASE_URL='postgres://wan_router:wan_router_dev@127.0.0.1:55432/wan_router' \
WAN_API_KEY_PEPPER='replace-with-at-least-32-random-bytes' \
WAN_CORS_ORIGINS=http://127.0.0.1:5178 \
npm start
```

Provider API keys are never accepted through server environment variables.
Create them through the Firebase-only control plane so they are encrypted and
tenant scoped:

```http
POST /api/provider-credentials
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{
	"provider": "openai",
	"name": "Primary OpenAI",
	"secret": "<official OpenAI API key>",
	"modelFilters": ["openai/gpt-4.1", "openai/gpt-4.1-mini"],
	"priority": 100
}
```

Then call `POST /api/provider-credentials/:id/verify`. Verification makes a
bounded official `GET /v1/models` request and never returns the secret or raw
provider error. Chat uses the highest-priority active credential whose exact
model filter matches; an empty filter is a provider-wide wildcard.

The current adapter supports text deltas, non-stream completions,
`response_format`, final token usage, timeout, and cancellation. Direct OpenAI
tool capability remains disabled in its catalog; the primary CLIProxy relay
normalizes tool-call deltas and finish reasons. Provider setup errors retain
their JSON HTTP status before SSE headers, while downstream writes wait for
slow-client drain.
The local fixture does not replace a cost-capped live staging test or provider
Terms review.

## Admission limits

Runtime admission is atomic in PostgreSQL across gateway instances for the same
workspace. Defaults:

```sh
WAN_LIMIT_REQUESTS_PER_MINUTE=60
WAN_LIMIT_MAX_CONCURRENT=4
WAN_LIMIT_MAX_TOKENS_PER_REQUEST=16384
WAN_LIMIT_DEFAULT_MAX_COMPLETION_TOKENS=4096
WAN_LIMIT_DAILY_TOKENS=1000000
```

Request rate is scoped per credential. Concurrency, daily tokens, and budget
are workspace-wide, so creating another WAN API key does not bypass hard
limits. Requests without `max_tokens` or `max_completion_tokens` receive the
configured hard default. Reservation size includes the full normalized request
plus output ceiling.

Budget remains optional until a reviewed provider price snapshot exists. When a
conservative integer price is configured, both values are required:

```sh
WAN_LIMIT_DAILY_BUDGET_MICROS=5000000
WAN_LIMIT_COST_MICROS_PER_TOKEN=2
```

These development counters do not replace Redis/load validation or immutable
model pricing. Metrics, audit, and alert resources are under `ops/`; production
activation still requires staging deployment and notification-channel rehearsal.

## Observability

Set a dedicated Secret Manager value with at least 32 bytes:

```sh
WAN_METRICS_BEARER_TOKEN='<collector-only bearer token>' npm start
curl -H "Authorization: Bearer $WAN_METRICS_BEARER_TOKEN" http://127.0.0.1:8080/metrics
```

WAN API keys and Firebase tokens are not valid metrics credentials. Metrics use
bounded route/provider/error labels and never include workspace, API-key, model,
request, prompt, completion, or tool-argument labels.

`GET /api/audit-events` requires a Firebase principal with `usage:read` and only
returns the authenticated workspace's immutable audit events. Audit metadata is
limited to simple allowlisted operational values; secret and raw request content
are not accepted.

Validation commands:

```sh
npm run security:scan
npm run ops:validate
docker run --rm --entrypoint /bin/promtool \
	-v "$PWD/ops/prometheus:/work:ro" -w /work \
	prom/prometheus:v3.5.0 test rules alert-tests.yml
```

See `docs/OBSERVABILITY-RUNBOOK.md` for deployment, alert ownership, incident
actions, local dashboard rehearsal, retention, and rollback.

## Security status

- Prompt, completion, Authorization headers, and raw request bodies are absent
	from the structured log allowlist.
- Plaintext WAN API keys are returned once and are absent from PostgreSQL,
	subsequent list responses, browser storage, and structured logs.
- Browser CORS is an exact allowlist and does not replace Bearer authentication.
- Provider plaintext is absent from storage and list responses. Cloud KMS wraps
	the per-record data key; workspace, credential ID, and provider are bound as
	AAD so wrapped keys cannot be moved across credential contexts.
- Upstream error bodies, provider credentials, prompts, and completions are not
	part of the structured log allowlist. OpenAI mode uses only the fixed official
	API origin and cannot be redirected through environment configuration.
- `npm audit --omit=dev` currently reports six Moderate findings through
	`firebase-admin` transitive packages. The published UUID advisory affects
	caller-supplied buffers in UUID v3/v5/v6; this service does not invoke those
	APIs. There are no High or Critical findings, but the Moderate findings remain
	an explicit release gate rather than being hidden with a forced downgrade.