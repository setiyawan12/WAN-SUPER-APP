CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('firebase', 'api-key', 'dev-static', 'system')),
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_occurred_idx
  ON audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_request_idx
  ON audit_events (request_id);

CREATE OR REPLACE FUNCTION reject_audit_event_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_immutable_write ON audit_events;
CREATE TRIGGER audit_events_immutable_write
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_update();

COMMENT ON TABLE audit_events IS
  'Append-only application audit trail. Retention requires a migration-owner transaction that temporarily disables the immutable trigger.';