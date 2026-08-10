import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ApiKeyService } from "./auth/api-keys.js";
import type { Authenticator, Principal, GatewayScope } from "./auth/authenticator.js";
import { requireFirebasePrincipal, requireScope } from "./auth/authenticator.js";
import type { AdmissionService } from "./admission/limits.js";
import { prepareChatAdmission } from "./admission/chat.js";
import type { ProviderCredentialService } from "./control/provider-credentials.js";
import type { RouterRepository } from "./data/repository.js";
import { GatewayError, normalizeError } from "./errors.js";
import { parseChatCompletion, type TokenUsage } from "./inference/contracts.js";
import { writeSseDone, writeSseJson } from "./inference/downstream-sse.js";
import { noopGenerationTracker, type GenerationTracker } from "./inference/generations.js";
import { consoleGatewayLogger, type GatewayLogger } from "./observability/logger.js";
import type { GatewayMetrics } from "./observability/metrics.js";
import {
  noopAuditRecorder,
  type AuditInput,
  type AuditRecorder,
} from "./observability/audit.js";
import type {
  NormalizedChatEvent,
  NormalizedToolCallDelta,
  ProviderAttemptObserver,
  ProviderAdapter,
} from "./providers/types.js";

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

interface RequestState {
  requestId: string;
  principal?: Principal;
}

interface AccumulatedToolCall {
  index: number;
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
  sawName: boolean;
  sawArguments: boolean;
}

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

export interface GatewayDependencies {
  dataAuthenticator: Authenticator;
  controlAuthenticator: Authenticator;
  apiKeyService: ApiKeyService;
  providerCredentialService: ProviderCredentialService;
  repository?: Pick<RouterRepository, "listGenerationSummaries" | "getUsageSummary">;
  provider: ProviderAdapter;
  generations?: GenerationTracker;
  admission?: AdmissionService;
  admissionDefaultMaxCompletionTokens?: number;
  admissionCostMicrosPerToken?: bigint;
  logger?: GatewayLogger;
  metrics?: GatewayMetrics;
  metricsBearerToken?: string;
  audit?: AuditRecorder;
  environment?: string;
  allowedOrigins?: readonly string[];
}

function state(response: Response): RequestState {
  return response.locals.wan as RequestState;
}

function asyncHandler(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

function authenticated(
  authenticator: Authenticator,
  scope: GatewayScope,
): ReturnType<typeof asyncHandler> {
  return asyncHandler(async (request, response, next) => {
    const principal = await authenticator.authenticate(request);
    state(response).principal = principal;
    requireScope(principal, scope);
    next();
  });
}

function controlAuthenticated(authenticator: Authenticator): ReturnType<typeof asyncHandler> {
  return asyncHandler(async (request, response, next) => {
    const principal = await authenticator.authenticate(request);
    state(response).principal = principal;
    requireFirebasePrincipal(principal);
    requireScope(principal, "keys:manage");
    next();
  });
}

function providerControlAuthenticated(authenticator: Authenticator): ReturnType<typeof asyncHandler> {
  return asyncHandler(async (request, response, next) => {
    const principal = await authenticator.authenticate(request);
    state(response).principal = principal;
    requireFirebasePrincipal(principal);
    requireScope(principal, "providers:manage");
    next();
  });
}

function firebaseControlAuthenticated(authenticator: Authenticator): ReturnType<typeof asyncHandler> {
  return asyncHandler(async (request, response, next) => {
    const principal = await authenticator.authenticate(request);
    state(response).principal = principal;
    requireFirebasePrincipal(principal);
    next();
  });
}

function usageControlAuthenticated(authenticator: Authenticator): ReturnType<typeof asyncHandler> {
  return asyncHandler(async (request, response, next) => {
    const principal = await authenticator.authenticate(request);
    state(response).principal = principal;
    requireFirebasePrincipal(principal);
    requireScope(principal, "usage:read");
    next();
  });
}

function uuidParam(value: string | string[] | undefined, label: string): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new GatewayError(400, "invalid_request_error", `invalid_${label}_id`, `${label} ID is invalid.`);
  }
  return id;
}

function auditLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new GatewayError(400, "invalid_request_error", "invalid_audit_limit", "Audit limit must be an integer between 1 and 500.");
  }
  return limit;
}

function generationLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new GatewayError(
      400,
      "invalid_request_error",
      "invalid_generation_limit",
      "Generation limit must be an integer between 1 and 200.",
    );
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new GatewayError(
      400,
      "invalid_request_error",
      "invalid_generation_limit",
      "Generation limit must be an integer between 1 and 200.",
    );
  }
  return limit;
}

function appendToolCallDelta(
  toolCalls: Map<number, AccumulatedToolCall>,
  delta: NormalizedToolCallDelta,
): void {
  let toolCall = toolCalls.get(delta.index);
  if (!toolCall) {
    toolCall = {
      index: delta.index,
      function: { name: "", arguments: "" },
      sawName: false,
      sawArguments: false,
    };
    toolCalls.set(delta.index, toolCall);
  }
  if (delta.id !== undefined) toolCall.id = delta.id;
  if (delta.type !== undefined) toolCall.type = delta.type;
  if (delta.function?.name !== undefined) {
    toolCall.sawName = true;
    toolCall.function.name += delta.function.name;
  }
  if (delta.function?.arguments !== undefined) {
    toolCall.sawArguments = true;
    toolCall.function.arguments += delta.function.arguments;
  }
}

function completedToolCalls(toolCalls: Map<number, AccumulatedToolCall>) {
  const ordered = [...toolCalls.values()].sort((left, right) => left.index - right.index);
  if (ordered.some((toolCall, index) => (
    toolCall.index !== index
    || !toolCall.id
    || toolCall.type !== "function"
    || !toolCall.sawName
    || !toolCall.function.name
    || !toolCall.sawArguments
  ))) {
    throw new GatewayError(502, "api_error", "provider_invalid_response", "The provider returned an incomplete tool call.");
  }
  return ordered.map((toolCall) => ({
    id: toolCall.id!,
    type: toolCall.type!,
    function: toolCall.function,
  }));
}

function streamedToolCall(delta: NormalizedToolCallDelta) {
  return {
    index: delta.index,
    ...(delta.id !== undefined ? { id: delta.id } : {}),
    ...(delta.type !== undefined ? { type: delta.type } : {}),
    ...(delta.function !== undefined ? { function: delta.function } : {}),
  };
}

function bearerMatches(request: Request, expected: string): boolean {
  const authorization = request.header("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice(7), "utf8");
  const target = Buffer.from(expected, "utf8");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

export function createGatewayApp(dependencies: GatewayDependencies) {
  const app = express();
  const logger = dependencies.logger ?? consoleGatewayLogger;
  const metrics = dependencies.metrics;
  const audit = dependencies.audit ?? noopAuditRecorder;
  const repository = dependencies.repository;
  const generations = dependencies.generations ?? noopGenerationTracker;
  const environment = dependencies.environment ?? "dev";
  const allowedOrigins = new Set(dependencies.allowedOrigins ?? []);
  const recordAudit = async (input: AuditInput): Promise<void> => {
    try {
      const recorded = await audit.record(input);
      if (recorded) metrics?.auditRecorded(input.action, input.outcome);
    } catch {
      metrics?.auditFailed(input.action);
      logger.error("audit_event_failed", {
        request_id: input.requestId,
        workspace_id: input.workspaceId,
        error_code: "audit_persistence_failed",
      });
    }
  };

  app.disable("x-powered-by");
  app.disable("etag");
  app.use((request, response, next) => {
    const requestedId = request.header("x-request-id") || "";
    const requestId = REQUEST_ID_PATTERN.test(requestedId) ? requestedId : `req_${randomUUID()}`;
    const startedAt = Date.now();
    response.locals.wan = { requestId } satisfies RequestState;
    response.setHeader("x-request-id", requestId);
    response.setHeader("Cache-Control", "no-store");
    let logged = false;
    const logCompletion = (status: number, errorCode?: string) => {
      if (logged) return;
      logged = true;
      const principal = state(response).principal;
      logger.info("request_completed", {
        request_id: requestId,
        method: request.method,
        path: request.path,
        status,
        latency_ms: Date.now() - startedAt,
        workspace_id: principal?.workspaceId,
        api_key_id: principal?.apiKeyId,
        error_code: errorCode,
      });
      metrics?.observeHttpRequest({
        method: request.method,
        path: request.path,
        status,
        durationMs: Date.now() - startedAt,
      });
    };
    response.once("finish", () => logCompletion(response.statusCode));
    response.once("close", () => {
      if (!response.writableEnded) logCompletion(499, "request_cancelled");
    });
    next();
  });
  app.use((request, response, next) => {
    const origin = request.header("origin");
    if (!origin) {
      next();
      return;
    }
    if (!allowedOrigins.has(origin)) {
      next(new GatewayError(403, "permission_error", "origin_not_allowed", "This browser origin is not allowed."));
      return;
    }

    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID");
    response.setHeader("Access-Control-Expose-Headers", "X-Request-ID");
    response.setHeader("Access-Control-Max-Age", "600");
    response.append("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", environment, provider: dependencies.provider.id });
  });

  if (metrics && dependencies.metricsBearerToken) {
    app.get(
      "/metrics",
      asyncHandler(async (request, response) => {
        if (!bearerMatches(request, dependencies.metricsBearerToken!)) {
          throw new GatewayError(401, "authentication_error", "invalid_metrics_token", "Metrics authentication failed.");
        }
        response.setHeader("Content-Type", metrics.contentType);
        response.send(await metrics.snapshot());
      }),
    );
  }

  app.get(
    "/api/me",
    firebaseControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (_request, response) => {
      response.json({
        capabilities: {
          providerCredentialProviders: dependencies.providerCredentialService.enabledProviders(),
        },
      });
    }),
  );

  app.get(
    "/api/keys",
    controlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (_request, response) => {
      const principal = state(response).principal!;
      response.json({ data: await dependencies.apiKeyService.list(principal.workspaceId) });
    }),
  );

  app.post(
    "/api/keys",
    controlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const created = await dependencies.apiKeyService.create(requestState.principal!.workspaceId, request.body);
      logger.info("api_key_created", {
        request_id: requestState.requestId,
        workspace_id: requestState.principal!.workspaceId,
        api_key_id: created.id,
      });
      await recordAudit({
        workspaceId: requestState.principal!.workspaceId,
        actorType: requestState.principal!.authType,
        actorId: requestState.principal!.subjectId,
        action: "api_key.created",
        resourceType: "api_key",
        resourceId: created.id,
        requestId: requestState.requestId,
        outcome: "succeeded",
        metadata: {
          environment,
          scopes_count: created.scopes.length,
        },
      });
      response.status(201).json(created);
    }),
  );

  app.get(
    "/api/generations",
    usageControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      if (!repository) throw new Error("Control read repository is not configured.");
      const principal = state(response).principal!;
      const records = await repository.listGenerationSummaries(
        principal.workspaceId,
        generationLimit(request.query.limit),
      );
      response.json({
        data: records.map((record) => ({
          id: record.id,
          requestId: record.requestId,
          apiKeyId: record.apiKeyId,
          requestedModel: record.requestedModel,
          resolvedModel: record.resolvedModel,
          providerEndpointId: record.providerEndpointId,
          status: record.status,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          totalTokens: record.totalTokens,
          usageEstimated: record.usageEstimated,
          requestStartedAt: record.requestStartedAt.toISOString(),
          firstTokenAt: record.firstTokenAt?.toISOString() ?? null,
          completedAt: record.completedAt?.toISOString() ?? null,
        })),
      });
    }),
  );

  app.get(
    "/api/usage",
    usageControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (_request, response) => {
      if (!repository) throw new Error("Control read repository is not configured.");
      const principal = state(response).principal!;
      response.json(await repository.getUsageSummary(principal.workspaceId));
    }),
  );

  app.get(
    "/api/audit-events",
    usageControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const principal = state(response).principal!;
      const events = await audit.list(principal.workspaceId, auditLimit(
        typeof request.query.limit === "string" ? request.query.limit : undefined,
      ));
      response.json({
        data: events.map((event) => ({
          id: event.id,
          actorType: event.actorType,
          actorId: event.actorId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          requestId: event.requestId,
          outcome: event.outcome,
          metadata: event.metadata,
          occurredAt: event.occurredAt.toISOString(),
        })),
      });
    }),
  );

  app.delete(
    "/api/keys/:id",
    controlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const keyId = uuidParam(request.params.id, "api_key");
      await dependencies.apiKeyService.revoke(requestState.principal!.workspaceId, keyId);
      logger.info("api_key_revoked", {
        request_id: requestState.requestId,
        workspace_id: requestState.principal!.workspaceId,
        api_key_id: keyId,
      });
      await recordAudit({
        workspaceId: requestState.principal!.workspaceId,
        actorType: requestState.principal!.authType,
        actorId: requestState.principal!.subjectId,
        action: "api_key.revoked",
        resourceType: "api_key",
        resourceId: keyId,
        requestId: requestState.requestId,
        outcome: "succeeded",
      });
      response.status(204).end();
    }),
  );

  app.get(
    "/api/provider-credentials",
    providerControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (_request, response) => {
      const principal = state(response).principal!;
      response.json({ data: await dependencies.providerCredentialService.list(principal.workspaceId) });
    }),
  );

  app.post(
    "/api/provider-credentials",
    providerControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const created = await dependencies.providerCredentialService.create(requestState.principal!.workspaceId, request.body);
      logger.info("provider_credential_created", {
        request_id: requestState.requestId,
        workspace_id: requestState.principal!.workspaceId,
        provider_id: created.provider,
      });
      await recordAudit({
        workspaceId: requestState.principal!.workspaceId,
        actorType: requestState.principal!.authType,
        actorId: requestState.principal!.subjectId,
        action: "provider_credential.created",
        resourceType: "provider_credential",
        resourceId: created.id,
        requestId: requestState.requestId,
        outcome: "succeeded",
        metadata: { provider: created.provider },
      });
      response.status(201).json(created);
    }),
  );

  app.patch(
    "/api/provider-credentials/:id",
    providerControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const id = uuidParam(request.params.id, "provider_credential");
      const updated = await dependencies.providerCredentialService.update(
        requestState.principal!.workspaceId,
        id,
        request.body,
      );
      logger.info("provider_credential_updated", {
        request_id: requestState.requestId,
        workspace_id: requestState.principal!.workspaceId,
        provider_id: updated.provider,
      });
      await recordAudit({
        workspaceId: requestState.principal!.workspaceId,
        actorType: requestState.principal!.authType,
        actorId: requestState.principal!.subjectId,
        action: "provider_credential.updated",
        resourceType: "provider_credential",
        resourceId: id,
        requestId: requestState.requestId,
        outcome: "succeeded",
        metadata: {
          provider: updated.provider,
          rotated: updated.rotatedAt !== null,
          status: updated.status,
        },
      });
      response.json(updated);
    }),
  );

  app.delete(
    "/api/provider-credentials/:id",
    providerControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const id = uuidParam(request.params.id, "provider_credential");
      await dependencies.providerCredentialService.delete(requestState.principal!.workspaceId, id);
      logger.info("provider_credential_deleted", {
        request_id: requestState.requestId,
        workspace_id: requestState.principal!.workspaceId,
      });
      await recordAudit({
        workspaceId: requestState.principal!.workspaceId,
        actorType: requestState.principal!.authType,
        actorId: requestState.principal!.subjectId,
        action: "provider_credential.deleted",
        resourceType: "provider_credential",
        resourceId: id,
        requestId: requestState.requestId,
        outcome: "succeeded",
      });
      response.status(204).end();
    }),
  );

  app.post(
    "/api/provider-credentials/:id/verify",
    providerControlAuthenticated(dependencies.controlAuthenticator),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const id = uuidParam(request.params.id, "provider_credential");
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", () => {
        if (!response.writableEnded) abort();
      });
      const verified = await dependencies.providerCredentialService.verify(
        requestState.principal!.workspaceId,
        id,
        controller.signal,
      );
      logger.info("provider_credential_verified", {
        request_id: requestState.requestId,
        workspace_id: requestState.principal!.workspaceId,
        provider_id: verified.provider,
        error_code: verified.status === "invalid" ? "provider_credential_invalid" : undefined,
      });
      await recordAudit({
        workspaceId: requestState.principal!.workspaceId,
        actorType: requestState.principal!.authType,
        actorId: requestState.principal!.subjectId,
        action: "provider_credential.verified",
        resourceType: "provider_credential",
        resourceId: id,
        requestId: requestState.requestId,
        outcome: verified.status === "invalid" ? "failed" : "succeeded",
        metadata: {
          provider: verified.provider,
          status: verified.status,
        },
      });
      response.json(verified);
    }),
  );

  app.get(
    "/v1/models",
    authenticated(dependencies.dataAuthenticator, "models:read"),
    asyncHandler(async (_request, response) => {
      const models = await dependencies.provider.listModels();
      response.json({
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: model.ownedBy,
        })),
      });
    }),
  );

  app.post(
    "/v1/chat/completions",
    authenticated(dependencies.dataAuthenticator, "chat:write"),
    asyncHandler(async (request, response) => {
      const requestState = state(response);
      const principal = requestState.principal!;
      const parsedInput = parseChatCompletion(request.body);
      const prepared = prepareChatAdmission(
        parsedInput,
        dependencies.admissionDefaultMaxCompletionTokens ?? 4_096,
      );
      const input = prepared.request;
      const generationId = `gen_${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const generationStartedAt = new Date();
      let finalized = false;
      let finalization: Promise<void> | undefined;
      let firstTokenRecorded = false;
      let firstTokenAt: Date | undefined;
      const finalizeOnce = async (operation: () => Promise<void>) => {
        if (finalized) return;
        if (finalization) return finalization;
        finalization = operation()
          .then(() => {
            finalized = true;
          })
          .finally(() => {
            if (!finalized) finalization = undefined;
          });
        return finalization;
      };
      const finalizeFailure = async (error: unknown) => {
        const normalized = normalizeError(error, requestState.requestId);
        const completedAt = new Date();
        const generationStatus = normalized.status === 499 ? "cancelled" : "failed";
        await finalizeOnce(async () => {
          await generations.fail({
            workspaceId: principal.workspaceId,
            generationId,
            status: generationStatus,
            resolvedModel: input.model,
            errorCode: normalized.body.error.code,
            completedAt,
          });
          logger.info("generation_finalized", {
            request_id: requestState.requestId,
            generation_id: generationId,
            generation_status: generationStatus,
            workspace_id: principal.workspaceId,
            api_key_id: principal.apiKeyId,
            requested_model: input.model,
            resolved_model: input.model,
            stream: input.stream,
            latency_ms: Math.max(0, completedAt.getTime() - generationStartedAt.getTime()),
            ttft_ms: firstTokenAt
              ? Math.max(0, firstTokenAt.getTime() - generationStartedAt.getTime())
              : undefined,
            error_code: normalized.body.error.code,
          });
          metrics?.generationFinalized({
            status: generationStatus,
            stream: input.stream,
            durationMs: Math.max(0, completedAt.getTime() - generationStartedAt.getTime()),
            ttftMs: firstTokenAt
              ? Math.max(0, firstTokenAt.getTime() - generationStartedAt.getTime())
              : undefined,
            errorCode: normalized.body.error.code,
          });
          if (providerAttemptCount > 1) metrics?.fallbackCompleted(false);
          await recordAudit({
            workspaceId: principal.workspaceId,
            actorType: principal.authType,
            actorId: principal.subjectId,
            action: generationStatus === "cancelled" ? "generation.cancelled" : "generation.failed",
            resourceType: "generation",
            resourceId: generationId,
            requestId: requestState.requestId,
            outcome: generationStatus,
            metadata: {
              requested_model: input.model,
              resolved_model: input.model,
              stream: input.stream,
              error_code: normalized.body.error.code,
              provider_attempts: providerAttemptCount,
            },
            occurredAt: completedAt,
          });
        });
      };
      const finalizeSuccess = async (usage: TokenUsage) => {
        const completedAt = new Date();
        await finalizeOnce(async () => {
          await generations.succeed({
            workspaceId: principal.workspaceId,
            generationId,
            resolvedModel: input.model,
            usage,
            completedAt,
          });
          logger.info("generation_finalized", {
            request_id: requestState.requestId,
            generation_id: generationId,
            generation_status: "succeeded",
            workspace_id: principal.workspaceId,
            api_key_id: principal.apiKeyId,
            requested_model: input.model,
            resolved_model: input.model,
            stream: input.stream,
            latency_ms: Math.max(0, completedAt.getTime() - generationStartedAt.getTime()),
            ttft_ms: firstTokenAt
              ? Math.max(0, firstTokenAt.getTime() - generationStartedAt.getTime())
              : undefined,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            usage_estimated: usage.estimated === true,
          });
          metrics?.generationFinalized({
            status: "succeeded",
            stream: input.stream,
            durationMs: Math.max(0, completedAt.getTime() - generationStartedAt.getTime()),
            ttftMs: firstTokenAt
              ? Math.max(0, firstTokenAt.getTime() - generationStartedAt.getTime())
              : undefined,
            usage,
          });
          if (providerAttemptCount > 1) metrics?.fallbackCompleted(true);
          await recordAudit({
            workspaceId: principal.workspaceId,
            actorType: principal.authType,
            actorId: principal.subjectId,
            action: "generation.succeeded",
            resourceType: "generation",
            resourceId: generationId,
            requestId: requestState.requestId,
            outcome: "succeeded",
            metadata: {
              requested_model: input.model,
              resolved_model: input.model,
              stream: input.stream,
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
              estimated: usage.estimated === true,
              provider_attempts: providerAttemptCount,
            },
            occurredAt: completedAt,
          });
        });
      };
      const recordFirstToken = async () => {
        if (firstTokenRecorded) return;
        const at = new Date();
        await generations.firstToken(principal.workspaceId, generationId, at);
        firstTokenRecorded = true;
        firstTokenAt = at;
      };
      await generations.start({
        id: generationId,
        workspaceId: principal.workspaceId,
        apiKeyId: principal.apiKeyId,
        requestId: requestState.requestId,
        requestedModel: input.model,
        startedAt: generationStartedAt,
      });
      metrics?.generationStarted(input.stream);
      let providerAttemptCount = 0;
      const providerAttemptMetrics = new Map<string, {
        providerId: string;
        startedAt: Date;
        firstTokenAt?: Date;
      }>();
      const trackedAttempts = (attempts: ProviderAttemptObserver): ProviderAttemptObserver => ({
        begin: async (attemptInput) => {
          const attemptId = await attempts.begin(attemptInput);
          providerAttemptCount += 1;
          providerAttemptMetrics.set(attemptId, {
            providerId: attemptInput.providerId,
            startedAt: attemptInput.startedAt,
          });
          metrics?.providerAttemptStarted(attemptInput.providerId);
          return attemptId;
        },
        firstToken: async (attemptId, at) => {
          await attempts.firstToken(attemptId, at);
          const attempt = providerAttemptMetrics.get(attemptId);
          if (attempt && !attempt.firstTokenAt) attempt.firstTokenAt = at;
        },
        finish: async (attemptId, attemptInput) => {
          await attempts.finish(attemptId, attemptInput);
          const attempt = providerAttemptMetrics.get(attemptId);
          if (!attempt) return;
          metrics?.providerAttemptFinished({
            providerId: attempt.providerId,
            status: attemptInput.status,
            durationMs: Math.max(0, attemptInput.completedAt.getTime() - attempt.startedAt.getTime()),
            ttftMs: attempt.firstTokenAt
              ? Math.max(0, attempt.firstTokenAt.getTime() - attempt.startedAt.getTime())
              : undefined,
            errorCode: attemptInput.errorCode,
          });
          providerAttemptMetrics.delete(attemptId);
        },
      });
      let reservationId: string | undefined;
      const requestedTokens = prepared.requestedTokens;
      const costMicrosPerToken = dependencies.admissionCostMicrosPerToken ?? 0n;
      try {
        if (dependencies.admission) {
          reservationId = (await dependencies.admission.reserve({
            workspaceId: principal.workspaceId,
            credentialId: principal.apiKeyId ?? `firebase:${principal.subjectId}`,
            generationId,
            requestedTokens,
            reservedCostMicros: BigInt(requestedTokens) * costMicrosPerToken,
            now: new Date(),
          })).id;
        }
      } catch (error) {
        const normalized = normalizeError(error, requestState.requestId);
        metrics?.admissionRejected(normalized.body.error.code);
        await finalizeFailure(error);
        throw error;
      }
      const settleAdmission = async (usage: TokenUsage) => {
        if (!reservationId || !dependencies.admission) return;
        const id = reservationId;
        if (usage.estimated === true) {
          const settledTokens = Math.max(requestedTokens, usage.total_tokens);
          await dependencies.admission.settle(id, settledTokens, BigInt(settledTokens) * costMicrosPerToken);
        } else {
          await dependencies.admission.settle(
            id,
            usage.total_tokens,
            BigInt(usage.total_tokens) * costMicrosPerToken,
          );
        }
        reservationId = undefined;
      };
      const releaseAdmission = async () => {
        if (!reservationId || !dependencies.admission) return;
        const id = reservationId;
        await dependencies.admission.release(id);
        reservationId = undefined;
      };
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.once("aborted", abort);
      response.once("close", () => {
        if (!response.writableEnded) {
          abort();
          void releaseAdmission().catch(() => {});
          void finalizeFailure(
            new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request."),
          ).catch(() => {});
        }
      });

      let events: AsyncIterable<NormalizedChatEvent>;
      try {
        events = dependencies.provider.chat(input, {
          requestId: requestState.requestId,
          workspaceId: principal.workspaceId,
          signal: controller.signal,
          attempts: trackedAttempts(generations.attempts(principal.workspaceId, generationId)),
        });
      } catch (error) {
        await releaseAdmission();
        await finalizeFailure(error);
        throw error;
      }

      if (!input.stream) {
        try {
          let text = "";
          const toolCallDeltas = new Map<number, AccumulatedToolCall>();
          let usage: TokenUsage | undefined;
          for await (const event of events) {
            if (event.type === "delta") {
              await recordFirstToken();
              text += event.text;
            } else if (event.type === "tool_call_delta") {
              await recordFirstToken();
              appendToolCallDelta(toolCallDeltas, event.toolCall);
            } else if (event.type === "usage") usage = event.usage;
          }
          if (!usage) {
            throw new GatewayError(502, "api_error", "provider_usage_missing", "The provider response did not include usage.");
          }
          const toolCalls = completedToolCalls(toolCallDeltas);
          await settleAdmission(usage);
          await finalizeSuccess(usage);
          response.json({
            id: generationId,
            object: "chat.completion",
            created,
            model: input.model,
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: toolCalls.length && !text ? null : text,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: toolCalls.length ? "tool_calls" : "stop",
            }],
            usage,
          });
          return;
        } catch (error) {
          await releaseAdmission();
          await finalizeFailure(error);
          throw error;
        }
      }

      let iterator: AsyncIterator<NormalizedChatEvent>;
      let firstEvent: IteratorResult<NormalizedChatEvent>;
      try {
        iterator = events[Symbol.asyncIterator]();
        firstEvent = await iterator.next();
      } catch (error) {
        await releaseAdmission();
        await finalizeFailure(error);
        throw error;
      }

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();

      let firstChunk = true;
      let finalUsage: TokenUsage | undefined;
      let sawToolCall = false;
      try {
        let current = firstEvent;
        while (!current.done) {
          const event = current.value;
          if (event.type === "delta") {
            await recordFirstToken();
            await writeSseJson(response, {
              id: generationId,
              object: "chat.completion.chunk",
              created,
              model: input.model,
              choices: [{
                index: 0,
                delta: firstChunk
                  ? { role: "assistant", content: event.text }
                  : { content: event.text },
                finish_reason: null,
              }],
            });
            firstChunk = false;
          } else if (event.type === "tool_call_delta") {
            await recordFirstToken();
            await writeSseJson(response, {
              id: generationId,
              object: "chat.completion.chunk",
              created,
              model: input.model,
              choices: [{
                index: 0,
                delta: {
                  ...(firstChunk ? { role: "assistant" } : {}),
                  tool_calls: [streamedToolCall(event.toolCall)],
                },
                finish_reason: null,
              }],
            });
            firstChunk = false;
            sawToolCall = true;
          } else if (event.type === "usage") {
            finalUsage = event.usage;
            await writeSseJson(response, {
              id: generationId,
              object: "chat.completion.chunk",
              created,
              model: input.model,
              choices: [],
              usage: event.usage,
            });
          }
          current = await iterator.next();
        }
        if (!finalUsage) {
          throw new GatewayError(502, "api_error", "provider_usage_missing", "The provider stream ended without final usage.");
        }
        await settleAdmission(finalUsage);
        await finalizeSuccess(finalUsage);
        await writeSseJson(response, {
          id: generationId,
          object: "chat.completion.chunk",
          created,
          model: input.model,
          choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : "stop" }],
        });
        await writeSseDone(response);
        response.end();
      } catch (error) {
        await releaseAdmission();
        await finalizeFailure(error);
        if (controller.signal.aborted || response.destroyed) return;
        const normalized = normalizeError(error, requestState.requestId);
        await writeSseJson(response, normalized.body);
        response.end();
      } finally {
        await iterator.return?.();
      }
    }),
  );

  app.use((_request, _response, next) => {
    next(new GatewayError(404, "invalid_request_error", "route_not_found", "The requested route was not found."));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const requestState = state(response);
    const mappedError = typeof error === "object" && error !== null && "type" in error
      ? (error as { type?: unknown }).type === "entity.too.large"
        ? new GatewayError(413, "invalid_request_error", "payload_too_large", "The request body is too large.")
        : (error as { type?: unknown }).type === "entity.parse.failed"
          ? new GatewayError(400, "invalid_request_error", "invalid_json", "The request body is not valid JSON.")
          : error
      : error;
    const normalized = normalizeError(mappedError, requestState.requestId);
    if (normalized.status === 401 || normalized.status === 403) {
      metrics?.authenticationFailed(normalized.body.error.code);
    }
    logger.error("request_failed", {
      request_id: requestState.requestId,
      status: normalized.status,
      workspace_id: requestState.principal?.workspaceId,
      api_key_id: requestState.principal?.apiKeyId,
      error_code: normalized.body.error.code,
    });
    if (!response.headersSent) response.status(normalized.status).json(normalized.body);
  });

  return app;
}