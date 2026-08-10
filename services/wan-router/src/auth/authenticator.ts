import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { GatewayError } from "../errors.js";

export type GatewayScope =
  | "models:read"
  | "chat:write"
  | "usage:read"
  | "keys:manage"
  | "providers:manage";

export interface Principal {
  authType: "firebase" | "api-key" | "dev-static";
  subjectId: string;
  workspaceId: string;
  apiKeyId?: string;
  scopes: ReadonlySet<GatewayScope>;
}

export interface Authenticator {
  authenticate(request: Request): Promise<Principal>;
}

export interface StaticBearerCredential {
  token: string;
  principal: Principal;
}

export class PrefixRoutingAuthenticator implements Authenticator {
  constructor(
    private readonly prefix: string,
    private readonly prefixedAuthenticator: Authenticator,
    private readonly fallbackAuthenticator: Authenticator,
  ) {}

  async authenticate(request: Request): Promise<Principal> {
    const token = bearerToken(request);
    return token.startsWith(this.prefix)
      ? this.prefixedAuthenticator.authenticate(request)
      : this.fallbackAuthenticator.authenticate(request);
  }
}

export function requireFirebasePrincipal(principal: Principal): void {
  if (principal.authType !== "firebase") {
    throw new GatewayError(403, "permission_error", "firebase_session_required", "A Firebase session is required.");
  }
}

export function bearerToken(request: Request): string {
  const header = request.header("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) {
    throw new GatewayError(401, "authentication_error", "invalid_api_key", "A valid Bearer token is required.");
  }
  return match[1];
}

function tokensEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class StaticBearerAuthenticator implements Authenticator {
  constructor(private readonly credentials: readonly StaticBearerCredential[]) {
    if (credentials.length === 0) throw new Error("At least one development credential is required.");
  }

  async authenticate(request: Request): Promise<Principal> {
    const token = bearerToken(request);
    const credential = this.credentials.find((candidate) => tokensEqual(token, candidate.token));
    if (!credential) {
      throw new GatewayError(401, "authentication_error", "invalid_api_key", "The Bearer token is invalid or revoked.");
    }
    return credential.principal;
  }
}

export function requireScope(principal: Principal, scope: GatewayScope): void {
  if (!principal.scopes.has(scope)) {
    throw new GatewayError(403, "permission_error", "insufficient_scope", `The credential requires ${scope}.`);
  }
}