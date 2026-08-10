import { cliproxyTransport } from "../renderer/transport/runtime";

export interface CloudModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export type CloudApiKeyScope = "models:read" | "chat:write" | "usage:read";

export interface CloudApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: CloudApiKeyScope[];
  status: "active" | "revoked";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedCloudApiKey extends CloudApiKey {
  key: string;
}

export type CloudProvider = "mock" | "openai";
export type CloudProviderCredentialStatus = "active" | "disabled" | "invalid";

export interface CloudRuntimeCapabilities {
  providerCredentialProviders: CloudProvider[];
}

export interface CloudProviderCredential {
  id: string;
  provider: CloudProvider;
  name: string;
  maskedValue: string;
  modelFilters: string[];
  priority: number;
  status: CloudProviderCredentialStatus;
  lastVerifiedAt: string | null;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
}

export interface CloudUsage {
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  generations: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    pending: number;
  };
  estimatedGenerations: number;
}

export interface CloudGeneration {
  id: string;
  requestId: string;
  apiKeyId: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  providerEndpointId: string | null;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageEstimated: boolean | null;
  requestStartedAt: string;
  firstTokenAt: string | null;
  completedAt: string | null;
}

interface ModelListResponse {
  object: "list";
  data: CloudModel[];
}

interface ErrorPayload {
  error?: {
    message?: string;
    request_id?: string;
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageForError(text: string, fallback: string): string {
  const payload = parseJson(text) as ErrorPayload | null;
  const message = payload?.error?.message;
  if (!message) return fallback;
  return payload?.error?.request_id ? `${message} (${payload.error.request_id})` : message;
}

function providerCredentialFromPayload(payload: unknown, fallback: string): CloudProviderCredential {
  const record = payload as Partial<CloudProviderCredential> | null;
  const provider = record?.provider;
  const priority = record?.priority;
  const status = record?.status;
  if (
    !record?.id
    || !record.name
    || !record.maskedValue
    || (provider !== "mock" && provider !== "openai")
    || (status !== "active" && status !== "disabled" && status !== "invalid")
    || !Array.isArray(record.modelFilters)
    || !record.modelFilters.every((model) => typeof model === "string")
    || typeof priority !== "number"
    || !Number.isInteger(priority)
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
  ) {
    throw new Error(fallback);
  }
  return {
    id: record.id,
    provider,
    name: record.name,
    maskedValue: record.maskedValue,
    modelFilters: [...record.modelFilters],
    priority,
    status,
    lastVerifiedAt: typeof record.lastVerifiedAt === "string" ? record.lastVerifiedAt : null,
    createdAt: record.createdAt,
    rotatedAt: typeof record.rotatedAt === "string" ? record.rotatedAt : null,
    updatedAt: record.updatedAt,
  };
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function generationFromPayload(payload: unknown): CloudGeneration {
  const record = payload as Partial<CloudGeneration> | null;
  const status = record?.status;
  if (
    !record?.id
    || !record.requestId
    || !record.requestedModel
    || (status !== "pending" && status !== "succeeded" && status !== "failed" && status !== "cancelled")
    || (record.promptTokens !== null && !nonNegativeNumber(record.promptTokens))
    || (record.completionTokens !== null && !nonNegativeNumber(record.completionTokens))
    || (record.totalTokens !== null && !nonNegativeNumber(record.totalTokens))
    || (record.usageEstimated !== null && typeof record.usageEstimated !== "boolean")
    || typeof record.requestStartedAt !== "string"
  ) {
    throw new Error("WAN Router Cloud returned an invalid generation list.");
  }
  return {
    id: record.id,
    requestId: record.requestId,
    apiKeyId: typeof record.apiKeyId === "string" ? record.apiKeyId : null,
    requestedModel: record.requestedModel,
    resolvedModel: typeof record.resolvedModel === "string" ? record.resolvedModel : null,
    providerEndpointId: typeof record.providerEndpointId === "string" ? record.providerEndpointId : null,
    status,
    promptTokens: record.promptTokens ?? null,
    completionTokens: record.completionTokens ?? null,
    totalTokens: record.totalTokens ?? null,
    usageEstimated: record.usageEstimated ?? null,
    requestStartedAt: record.requestStartedAt,
    firstTokenAt: typeof record.firstTokenAt === "string" ? record.firstTokenAt : null,
    completedAt: typeof record.completedAt === "string" ? record.completedAt : null,
  };
}

export async function getCloudRuntimeCapabilities(signal?: AbortSignal): Promise<CloudRuntimeCapabilities> {
  const response = await cliproxyTransport().request({ method: "GET", path: "/api/me", signal });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  const payload = parseJson(response.text) as {
    capabilities?: { providerCredentialProviders?: unknown[] };
  } | null;
  const providers = payload?.capabilities?.providerCredentialProviders;
  if (!Array.isArray(providers) || !providers.every((provider) => provider === "mock" || provider === "openai")) {
    throw new Error("WAN Router Cloud returned invalid runtime capabilities.");
  }
  return { providerCredentialProviders: [...providers] };
}

export async function listCloudModels(signal?: AbortSignal): Promise<CloudModel[]> {
  const response = await cliproxyTransport().request({ method: "GET", path: "/v1/models", signal });
  if (!response.ok) {
    throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  }
  const payload = parseJson(response.text) as ModelListResponse | null;
  if (payload?.object !== "list" || !Array.isArray(payload.data)) {
    throw new Error("WAN Router Cloud returned an invalid model catalog.");
  }
  return payload.data;
}

export async function listCloudApiKeys(signal?: AbortSignal): Promise<CloudApiKey[]> {
  const response = await cliproxyTransport().request({ method: "GET", path: "/api/keys", signal });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  const payload = parseJson(response.text) as { data?: CloudApiKey[] } | null;
  if (!Array.isArray(payload?.data)) throw new Error("WAN Router Cloud returned an invalid API-key list.");
  return payload.data;
}

export async function createCloudApiKey(input: {
  name: string;
  scopes: CloudApiKeyScope[];
  expiresAt?: string | null;
}): Promise<CreatedCloudApiKey> {
  const response = await cliproxyTransport().request({
    method: "POST",
    path: "/api/keys",
    contentType: "application/json",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  const payload = parseJson(response.text) as CreatedCloudApiKey | null;
  if (!payload?.id || !payload.key || !payload.prefix) {
    throw new Error("WAN Router Cloud returned an invalid API-key response.");
  }
  return payload;
}

export async function revokeCloudApiKey(id: string): Promise<void> {
  const response = await cliproxyTransport().request({
    method: "DELETE",
    path: `/api/keys/${encodeURIComponent(id)}`,
  });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
}

export async function listCloudProviderCredentials(signal?: AbortSignal): Promise<CloudProviderCredential[]> {
  const response = await cliproxyTransport().request({ method: "GET", path: "/api/provider-credentials", signal });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  const payload = parseJson(response.text) as { data?: unknown[] } | null;
  if (!Array.isArray(payload?.data)) throw new Error("WAN Router Cloud returned an invalid provider credential list.");
  return payload.data.map((entry) => providerCredentialFromPayload(
    entry,
    "WAN Router Cloud returned an invalid provider credential list.",
  ));
}

export async function createCloudProviderCredential(input: {
  provider: CloudProvider;
  name: string;
  secret: string;
  modelFilters: string[];
  priority: number;
}): Promise<CloudProviderCredential> {
  const response = await cliproxyTransport().request({
    method: "POST",
    path: "/api/provider-credentials",
    contentType: "application/json",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  return providerCredentialFromPayload(
    parseJson(response.text),
    "WAN Router Cloud returned an invalid provider credential response.",
  );
}

export async function verifyCloudProviderCredential(id: string): Promise<CloudProviderCredential> {
  const response = await cliproxyTransport().request({
    method: "POST",
    path: `/api/provider-credentials/${encodeURIComponent(id)}/verify`,
  });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  return providerCredentialFromPayload(
    parseJson(response.text),
    "WAN Router Cloud returned an invalid provider verification response.",
  );
}

export async function deleteCloudProviderCredential(id: string): Promise<void> {
  const response = await cliproxyTransport().request({
    method: "DELETE",
    path: `/api/provider-credentials/${encodeURIComponent(id)}`,
  });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
}

export async function getCloudUsage(signal?: AbortSignal): Promise<CloudUsage> {
  const response = await cliproxyTransport().request({ method: "GET", path: "/api/usage", signal });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  const payload = parseJson(response.text) as CloudUsage | null;
  if (
    !payload?.totals
    || !payload.generations
    || !nonNegativeNumber(payload.totals.promptTokens)
    || !nonNegativeNumber(payload.totals.completionTokens)
    || !nonNegativeNumber(payload.totals.totalTokens)
    || !nonNegativeNumber(payload.generations.total)
    || !nonNegativeNumber(payload.generations.succeeded)
    || !nonNegativeNumber(payload.generations.failed)
    || !nonNegativeNumber(payload.generations.cancelled)
    || !nonNegativeNumber(payload.generations.pending)
    || !nonNegativeNumber(payload.estimatedGenerations)
  ) {
    throw new Error("WAN Router Cloud returned an invalid usage summary.");
  }
  return {
    totals: { ...payload.totals },
    generations: { ...payload.generations },
    estimatedGenerations: payload.estimatedGenerations,
  };
}

export async function listRecentCloudGenerations(signal?: AbortSignal): Promise<CloudGeneration[]> {
  const response = await cliproxyTransport().request({ method: "GET", path: "/api/generations?limit=50", signal });
  if (!response.ok) throw new Error(messageForError(response.text, `WAN Router Cloud returned ${response.status}.`));
  const payload = parseJson(response.text) as { data?: unknown[] } | null;
  if (!Array.isArray(payload?.data)) throw new Error("WAN Router Cloud returned an invalid generation list.");
  return payload.data.map(generationFromPayload);
}