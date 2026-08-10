CREATE TABLE IF NOT EXISTS generations (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id text,
  request_id text NOT NULL,
  requested_model text NOT NULL,
  resolved_model text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  usage_estimated boolean,
  error_code text,
  request_started_at timestamptz NOT NULL,
  first_token_at timestamptz,
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS generations_workspace_request_idx
  ON generations (workspace_id, request_id);

CREATE INDEX IF NOT EXISTS generations_workspace_started_idx
  ON generations (workspace_id, request_started_at DESC);

CREATE INDEX IF NOT EXISTS generations_pending_idx
  ON generations (request_started_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS provider_attempts (
  id uuid PRIMARY KEY,
  generation_id text NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  endpoint_id text NOT NULL,
  credential_id uuid REFERENCES provider_credentials(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  usage_estimated boolean,
  error_code text,
  started_at timestamptz NOT NULL,
  first_token_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS provider_attempts_generation_started_idx
  ON provider_attempts (generation_id, started_at);

CREATE INDEX IF NOT EXISTS provider_attempts_pending_idx
  ON provider_attempts (started_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS usage_ledger (
  generation_id text NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN ('prompt_tokens', 'completion_tokens', 'total_tokens')),
  quantity integer NOT NULL CHECK (quantity >= 0),
  estimated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (generation_id, dimension)
);

CREATE INDEX IF NOT EXISTS usage_ledger_workspace_created_idx
  ON usage_ledger (workspace_id, created_at DESC);