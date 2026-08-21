type Unsubscribe = () => void;

interface HostView {
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
  environment: "none" | "prod" | "staging" | "dev";
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
}

interface SessionView {
  sessionId: string;
  hostId: string | null;
  label: string;
  environment: HostView["environment"];
  status: string;
  local: boolean;
}

declare global {
  interface Window {
    api?: any;
  }
}

export {};