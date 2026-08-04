// Type surface for the preload-exposed window.wan bridge (src/preload/index.cjs).

export interface WanRequestInit {
  method?: string;
  path: string;
  body?: string;
  contentType?: string;
}

export interface WanResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

export interface WanVsCodeState {
  targets: string[];
  variants: { path: string; hasEntry: boolean }[];
}

export interface WanSyncResult {
  ok: boolean;
  modelCount: number;
  changed: boolean;
  createdAny: boolean;
  targets: string[];
  error?: string;
}

export interface WanJetBrainsTarget {
  product: string;
  file: string;
  hasEntry: boolean;
}

export interface WanJetBrainsState {
  targets: WanJetBrainsTarget[];
  running: string[];
}

export interface WanJetBrainsTargetResult {
  product: string;
  file: string;
  status: "written" | "unchanged" | "error";
  error?: string;
}

export interface WanJetBrainsSyncResult {
  ok: boolean;
  modelCount: number;
  targets: WanJetBrainsTargetResult[];
  running: string[];
  keychainSupported: boolean;
  keychainWritten: number;
  error?: string;
}

export type CoworkPolicy = "readonly" | "safe" | "trusted" | "full";
export type ChatComposerMode = "ask" | "chat" | "agent";

export interface WanAppSettings {
  autoStartServer: boolean;
  requireApiKey: boolean;
  autoSyncVsCode: boolean;
  autoLaunch: boolean;
  startHidden: boolean;
  coworkPolicy: CoworkPolicy;
  maxToolCalls: number;
  chatComposerMode: ChatComposerMode;
}

// In-app Chat (HANDBOOK M1). Usage shape mirrors the OpenAI streaming
// `usage` object delivered on the final chunk via stream_options.include_usage.
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Cowork Mode (HANDBOOK-WAN-COWORK-MODE). Tool timeline + write approvals.
export type ToolStatus = "running" | "ok" | "error" | "rejected" | "aborted" | "done";

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  summary?: string;
  diff?: string;
  output?: string;
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  danger: boolean;
  diff?: string;
}

export interface CoworkProject {
  id: string;
  name: string;
  root: string;
  git: boolean;
  addedAt: number;
}

export interface CoworkState {
  project: CoworkProject | null;
  canUndo: boolean;
  lastCheckpoint: string | null;
}

export type ChatStreamEvent =
  | { reqId: string; type: "delta"; text: string }
  | { reqId: string; type: "usage"; usage: ChatUsage }
  | {
      reqId: string;
      type: "tool";
      name: string;
      status: ToolStatus;
      view?: ToolCallView;
    }
  | { reqId: string; type: "approval"; request: ApprovalRequest }
  | { reqId: string; type: "done" }
  | { reqId: string; type: "aborted" }
  | { reqId: string; type: "error"; error: string };

export interface ChatStartInit {
  reqId: string;
  model: string;
  messages: { role: string; content: unknown }[];
  temperature?: number;
  maxTokens?: number;
  useTools?: boolean; // M6 — enable the built-in local tool loop (fetch_url)
  cowork?: boolean; // Cowork Mode — filesystem + shell tools when a folder is selected
  mode?: ChatComposerMode;
  policy?: CoworkPolicy;
  maxToolCalls?: number;
}

export interface WanChat {
  start: (p: ChatStartInit) => Promise<void>;
  abort: (reqId: string) => Promise<void>;
  approve: (id: string) => Promise<boolean>;
  reject: (id: string) => Promise<boolean>;
  onStream: (cb: (ev: ChatStreamEvent) => void) => () => void;
}

export interface WanCowork {
  pick: () => Promise<CoworkProject | null>;
  set: (root: string) => Promise<CoworkProject>;
  clear: () => Promise<void>;
  state: () => Promise<CoworkState>;
  checkpoint: () => Promise<{ ok: boolean; id?: string; error?: string }>;
  undo: () => Promise<{ ok: boolean; error?: string }>;
}

// Conversation history (HANDBOOK M2). Mirrors src/main/chat-store.ts.
export interface ChatAttachment {
  type: "image";
  dataUrl: string;
  name?: string;
}

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  createdAt: number;
  usage?: { input: number; output: number; total: number; costUsd?: number };
  attachments?: ChatAttachment[];
  error?: string;
  /** Persisted tool timeline so Cowork steps survive an app restart. */
  tools?: ToolCallView[];
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  systemPrompt?: string;
  projectId?: string; // owning project / space (M6)
  messages: ChatMessageRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  projectId?: string; // owning project / space (M6)
  updatedAt: number;
  messageCount: number;
}

export interface ConversationSearchHit {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  snippet: string;
  messageId?: string;
}

export interface WanConvo {
  list: () => Promise<ConversationSummary[]>;
  get: (id: string) => Promise<Conversation | null>;
  save: (convo: Conversation) => Promise<ConversationSummary>;
  delete: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<ConversationSummary | null>;
  search: (query: string, limit?: number) => Promise<ConversationSearchHit[]>;
}

// Chat context sources (HANDBOOK M5). Mirrors src/main/context-service.ts.
export interface FileContext {
  kind: "file";
  name: string;
  path: string;
  size: number;
  text: string;
  truncated: boolean;
}

export interface UrlContext {
  kind: "url";
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface WanContext {
  pickFiles: () => Promise<FileContext[]>;
  fetchUrl: (url: string) => Promise<UrlContext>;
  hasSuperApp: () => Promise<boolean>;
  consumeSuperApp: () => Promise<{ label: string; text: string; source: "ssh"; createdAt: number } | null>;
}

// Projects / Spaces (HANDBOOK M6). Mirrors src/main/projects-store.ts.
export interface Project {
  id: string;
  name: string;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WanProject {
  list: () => Promise<Project[]>;
  create: (name: string, systemPrompt?: string) => Promise<Project>;
  update: (id: string, patch: { name?: string; systemPrompt?: string }) => Promise<Project | null>;
  delete: (id: string) => Promise<void>;
}

export interface WanQuick {
  hide: () => Promise<void>;
}

export interface WanBridge {
  chat: WanChat;
  convo: WanConvo;
  context: WanContext;
  project: WanProject;
  cowork: WanCowork;
  quick: WanQuick;
  request: (req: WanRequestInit) => Promise<WanResponse>;
  syncNow: () => Promise<WanSyncResult>;
  copyApiKey: () => Promise<{ ok: boolean; error?: string }>;
  openExternal: (url: string) => Promise<void>;
  vscodeState: () => Promise<WanVsCodeState>;
  backendInfo: () => Promise<{ port: number; proxyUrl: string }>;
  copyText: (text: string) => Promise<void>;
  jetbrainsSync: () => Promise<WanJetBrainsSyncResult>;
  jetbrainsState: () => Promise<WanJetBrainsState>;
  health: () => Promise<unknown>;
  getSettings: () => Promise<WanAppSettings>;
  setSetting: <K extends keyof WanAppSettings>(key: K, value: WanAppSettings[K]) => Promise<WanAppSettings>;
  focus: () => Promise<void>;
  onEvent: (cb: (ev: { type: string; payload: unknown }) => void) => () => void;
}

declare global {
  interface Window {
    wan: WanBridge;
  }
}

export {};
