export type Environment = "none" | "prod" | "staging" | "dev";

export type Host = {
  id: string;
  vaultId: "local" | "personal";
  groupId: string | null;
  label: string;
  address: string;
  port: number | null;
  protocol: string;
  identityId: string | null;
  keyId: string | null;
  jumpHostId: string | null;
  startupSnippetId: string | null;
  useLocalAgent: boolean;
  tags: string[];
  environment: Environment;
  favorite: boolean;
  agentForwarding: boolean;
  autoReconnect: boolean;
  reconnectLimit: number;
  keepAliveInterval: number;
  lastConnectedAt: number | null;
  effectiveUsername: string | null;
  effectivePort: number | null;
  hasCredential: boolean;
  groupPath: string[];
  openSshAlias?: string | null;
};

export type Group = {
  id: string;
  parentId: string | null;
  name: string;
  defaults: Record<string, unknown>;
};

export type Identity = {
  id: string;
  vaultId: "local" | "personal";
  label: string;
  username: string;
  keyId: string | null;
  hasSecret: boolean;
};

export type SshKey = {
  id: string;
  label: string;
  algorithm: string;
  bits: number | null;
  publicKey: string;
  fingerprintSha256: string;
  source: string;
};

export type Snippet = {
  id: string;
  vaultId: "local" | "personal";
  label: string;
  command: string;
  description: string;
  tags: string[];
  updatedAt: number;
};

export type Session = {
  sessionId: string;
  hostId: string | null;
  label: string;
  environment: Environment;
  status: "connecting" | "authenticating" | "connected" | "reconnecting" | "disconnected" | "error" | "closed";
  local: boolean;
  message?: string;
  reason?: string;
};

export type RemoteEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  mode: number;
  modifiedAt: number;
};

export type TransferJob = {
  id: string;
  sessionId: string;
  direction: "upload" | "download";
  source: string;
  destination: string;
  state: "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
  transferred: number;
  total: number;
  error?: string;
};

export type Tunnel = {
  id: string;
  sessionId: string;
  kind: "local" | "remote" | "dynamic";
  label: string;
  bindAddress: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  state: "active" | "reconnecting" | "stopping" | "error";
  error?: string;
};

export type Diagnostics = {
  hostId: string;
  address: string;
  port: number;
  ok: boolean;
  checkedAt: number;
  phases: Array<{
    name: "resolve" | "tcp" | "ssh";
    ok: boolean;
    durationMs: number;
    detail: string;
  }>;
};

export type Catalog = {
  hosts: Host[];
  groups: Group[];
  identities: Identity[];
  keys: SshKey[];
  snippets: Snippet[];
};