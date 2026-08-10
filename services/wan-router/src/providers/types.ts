import type { NormalizedChatRequest, TokenUsage } from "../inference/contracts.js";

export interface ProviderModel {
  id: string;
  ownedBy: string;
  status: "active" | "preview" | "disabled";
  capabilities: {
    tools: boolean;
    responseFormat: boolean;
  };
}

export interface ProviderContext {
  requestId: string;
  workspaceId: string;
  signal: AbortSignal;
  attempts?: ProviderAttemptObserver;
}

export interface ProviderAttemptObserver {
  begin(input: {
    providerId: string;
    endpointId: string;
    credentialId?: string;
    startedAt: Date;
  }): Promise<string>;
  firstToken(attemptId: string, at: Date): Promise<void>;
  finish(attemptId: string, input: {
    status: "succeeded" | "failed" | "cancelled";
    usage?: TokenUsage;
    errorCode?: string;
    completedAt: Date;
  }): Promise<void>;
}

export interface NormalizedToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type NormalizedChatEvent =
  | { type: "ready" }
  | { type: "delta"; text: string }
  | { type: "tool_call_delta"; toolCall: NormalizedToolCallDelta }
  | { type: "usage"; usage: TokenUsage };

export interface ProviderAdapter {
  readonly id: string;
  listModels(): Promise<ProviderModel[]>;
  chat(request: NormalizedChatRequest, context: ProviderContext): AsyncIterable<NormalizedChatEvent>;
}