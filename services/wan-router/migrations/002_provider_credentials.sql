CREATE TABLE IF NOT EXISTS provider_credentials (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  name text NOT NULL,
  ciphertext text NOT NULL,
  ciphertext_iv text NOT NULL,
  ciphertext_tag text NOT NULL,
  wrapped_key text NOT NULL,
  wrapped_key_iv text NOT NULL,
  wrapped_key_tag text NOT NULL,
  key_version text NOT NULL,
  masked_value text NOT NULL,
  model_filters text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invalid')),
  last_verified_at timestamptz,
  last_verification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_credentials_workspace_created_idx
  ON provider_credentials (workspace_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS provider_credentials_workspace_name_idx
  ON provider_credentials (workspace_id, lower(name));