DROP INDEX IF EXISTS generations_workspace_request_idx;

CREATE INDEX IF NOT EXISTS generations_workspace_request_idx
  ON generations (workspace_id, request_id);