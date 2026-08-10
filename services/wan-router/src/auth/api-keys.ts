import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { GatewayError } from "../errors.js";
import type { ApiKeyRecord, RouterRepository } from "../data/repository.js";
import { bearerToken, type Authenticator, type GatewayScope, type Principal } from "./authenticator.js";
import type { Request } from "express";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_PATTERN = new RegExp(`^wan_sk_(dev|staging|live)_(${UUID_PATTERN})_([A-Za-z0-9_-]{32,})$`);
const MANAGEABLE_SCOPES = ["models:read", "chat:write", "usage:read"] as const;

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(MANAGEABLE_SCOPES)).min(1).max(MANAGEABLE_SCOPES.length),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: GatewayScope[];
  status: ApiKeyRecord["status"];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey extends ApiKeyView {
  key: string;
}

function digestSecret(pepper: string, keyId: string, secret: string): Buffer {
  return createHmac("sha256", pepper).update(`${keyId}:${secret}`).digest();
}

function digestMatches(actualHex: string, expected: Buffer): boolean {
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function view(record: ApiKeyRecord): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: [...record.scopes],
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
  };
}

export class ApiKeyService {
  constructor(
    private readonly repository: RouterRepository,
    private readonly pepper: string,
    private readonly environment: "dev" | "staging" | "live",
  ) {
    if (Buffer.byteLength(pepper) < 32) throw new Error("WAN API-key pepper must be at least 32 bytes.");
  }

  async create(workspaceId: string, input: unknown): Promise<CreatedApiKey> {
    const parsed = createApiKeySchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayError(
        400,
        "invalid_request_error",
        "invalid_api_key_request",
        parsed.error.issues[0]?.message || "The API-key request is invalid.",
      );
    }

    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new GatewayError(400, "invalid_request_error", "invalid_expiry", "API-key expiry must be in the future.");
    }

    const id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const key = `wan_sk_${this.environment}_${id}_${secret}`;
    const prefix = `wan_sk_${this.environment}_${id.slice(0, 8)}...`;
    const record = await this.repository.createApiKey({
      id,
      workspaceId,
      name: parsed.data.name,
      environment: this.environment,
      prefix,
      digest: digestSecret(this.pepper, id, secret).toString("hex"),
      scopes: [...new Set(parsed.data.scopes)],
      expiresAt,
    });
    return { ...view(record), key };
  }

  async list(workspaceId: string): Promise<ApiKeyView[]> {
    return (await this.repository.listApiKeys(workspaceId)).map(view);
  }

  async revoke(workspaceId: string, id: string): Promise<void> {
    const revoked = await this.repository.revokeApiKey(workspaceId, id, new Date());
    if (!revoked) throw new GatewayError(404, "invalid_request_error", "api_key_not_found", "API key was not found.");
  }

  async authenticate(rawKey: string): Promise<Principal> {
    const match = KEY_PATTERN.exec(rawKey);
    if (!match) {
      throw new GatewayError(401, "authentication_error", "invalid_api_key", "The WAN API key is malformed.");
    }
    const [, environment, id, secret] = match;
    if (environment !== this.environment) {
      throw new GatewayError(401, "authentication_error", "invalid_api_key", "The WAN API key belongs to another environment.");
    }

    const record = await this.repository.findApiKeyById(id);
    const valid = record
      && record.environment === environment
      && record.status === "active"
      && (!record.expiresAt || record.expiresAt.getTime() > Date.now())
      && digestMatches(record.digest, digestSecret(this.pepper, id, secret));
    if (!valid || !record) {
      throw new GatewayError(401, "authentication_error", "invalid_api_key", "The WAN API key is invalid, expired, or revoked.");
    }

    await this.repository.touchApiKey(record.id, new Date());
    return {
      authType: "api-key",
      subjectId: record.id,
      workspaceId: record.workspaceId,
      apiKeyId: record.id,
      scopes: new Set(record.scopes),
    };
  }
}

export class WanApiKeyAuthenticator implements Authenticator {
  constructor(private readonly service: ApiKeyService) {}

  authenticate(request: Request): Promise<Principal> {
    return this.service.authenticate(bearerToken(request));
  }
}