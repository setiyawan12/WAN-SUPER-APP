import { randomUUID } from "node:crypto";
import type { RouterRepository } from "../data/repository.js";
import type { TokenUsage } from "./contracts.js";
import type { ProviderAttemptObserver } from "../providers/types.js";

export interface GenerationTracker {
  start(input: {
    id: string;
    workspaceId: string;
    apiKeyId?: string;
    requestId: string;
    requestedModel: string;
    startedAt: Date;
  }): Promise<void>;
  firstToken(workspaceId: string, generationId: string, at: Date): Promise<void>;
  succeed(input: {
    workspaceId: string;
    generationId: string;
    resolvedModel: string;
    usage: TokenUsage;
    completedAt: Date;
  }): Promise<void>;
  fail(input: {
    workspaceId: string;
    generationId: string;
    status: "failed" | "cancelled";
    resolvedModel?: string;
    errorCode: string;
    completedAt: Date;
  }): Promise<void>;
  attempts(workspaceId: string, generationId: string): ProviderAttemptObserver;
}

export class GenerationService implements GenerationTracker {
  constructor(private readonly repository: RouterRepository) {}

  async start(input: Parameters<GenerationTracker["start"]>[0]): Promise<void> {
    await this.repository.createGeneration({
      id: input.id,
      workspaceId: input.workspaceId,
      apiKeyId: input.apiKeyId ?? null,
      requestId: input.requestId,
      requestedModel: input.requestedModel,
      requestStartedAt: input.startedAt,
    });
  }

  async firstToken(workspaceId: string, generationId: string, at: Date): Promise<void> {
    await this.repository.markGenerationFirstToken(workspaceId, generationId, at);
  }

  async succeed(input: Parameters<GenerationTracker["succeed"]>[0]): Promise<void> {
    await this.repository.finalizeGeneration(input.workspaceId, input.generationId, {
      status: "succeeded",
      resolvedModel: input.resolvedModel,
      usage: input.usage,
      completedAt: input.completedAt,
    });
  }

  async fail(input: Parameters<GenerationTracker["fail"]>[0]): Promise<void> {
    await this.repository.finalizeGeneration(input.workspaceId, input.generationId, {
      status: input.status,
      resolvedModel: input.resolvedModel ?? null,
      errorCode: input.errorCode,
      completedAt: input.completedAt,
    });
  }

  attempts(workspaceId: string, generationId: string): ProviderAttemptObserver {
    return {
      begin: async (input) => {
        const id = randomUUID();
        await this.repository.createProviderAttempt({
          id,
          generationId,
          workspaceId,
          providerId: input.providerId,
          endpointId: input.endpointId,
          credentialId: input.credentialId ?? null,
          startedAt: input.startedAt,
        });
        return id;
      },
      firstToken: async (attemptId, at) => {
        await this.repository.markProviderAttemptFirstToken(workspaceId, attemptId, at);
      },
      finish: async (attemptId, input) => {
        await this.repository.finalizeProviderAttempt(workspaceId, attemptId, {
          status: input.status,
          usage: input.usage,
          errorCode: input.errorCode,
          completedAt: input.completedAt,
        });
      },
    };
  }

  async reconcileStale(cutoff: Date, completedAt = new Date()) {
    return this.repository.reconcileStaleGenerations(cutoff, completedAt);
  }
}

export const noopGenerationTracker: GenerationTracker = {
  async start() {},
  async firstToken() {},
  async succeed() {},
  async fail() {},
  attempts() {
    return {
      async begin() { return randomUUID(); },
      async firstToken() {},
      async finish() {},
    };
  },
};