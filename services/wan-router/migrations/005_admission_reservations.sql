CREATE TABLE IF NOT EXISTS admission_reservations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  generation_id text NOT NULL UNIQUE REFERENCES generations(id) ON DELETE CASCADE,
  minute_bucket timestamptz NOT NULL,
  day_bucket date NOT NULL,
  reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
  reserved_cost_micros bigint NOT NULL CHECK (reserved_cost_micros >= 0),
  actual_tokens integer CHECK (actual_tokens >= 0),
  actual_cost_micros bigint CHECK (actual_cost_micros >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'released')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS admission_reservations_scope_active_idx
  ON admission_reservations (workspace_id, credential_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS admission_reservations_scope_minute_idx
  ON admission_reservations (workspace_id, credential_id, minute_bucket);

CREATE INDEX IF NOT EXISTS admission_reservations_scope_day_idx
  ON admission_reservations (workspace_id, credential_id, day_bucket);