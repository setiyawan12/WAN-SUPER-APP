import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import type { Request } from "express";
import type { RouterRepository } from "../data/repository.js";
import { GatewayError } from "../errors.js";
import { bearerToken, type Authenticator, type Principal } from "./authenticator.js";

export interface WorkspaceResolver {
  resolvePersonalWorkspace(firebaseUid: string): Promise<string>;
}

export class RepositoryWorkspaceResolver implements WorkspaceResolver {
  constructor(private readonly repository: RouterRepository) {}

  async resolvePersonalWorkspace(firebaseUid: string): Promise<string> {
    return (await this.repository.ensurePersonalWorkspace(firebaseUid)).workspaceId;
  }
}

export class FirebaseIdTokenAuthenticator implements Authenticator {
  constructor(
    private readonly auth: Auth,
    private readonly workspaceResolver: WorkspaceResolver,
  ) {}

  async authenticate(request: Request): Promise<Principal> {
    const token = bearerToken(request);
    let firebaseUid: string;
    try {
      const decoded = await this.auth.verifyIdToken(token, true);
      firebaseUid = decoded.uid;
    } catch {
      throw new GatewayError(
        401,
        "authentication_error",
        "invalid_firebase_token",
        "The Firebase session is invalid, expired, revoked, or belongs to another project.",
      );
    }

    let workspaceId: string;
    try {
      workspaceId = await this.workspaceResolver.resolvePersonalWorkspace(firebaseUid);
    } catch {
      throw new GatewayError(
        503,
        "api_error",
        "tenant_resolution_unavailable",
        "WAN Router could not resolve the authenticated workspace.",
      );
    }

    return {
      authType: "firebase",
      subjectId: firebaseUid,
      workspaceId,
      scopes: new Set(["models:read", "chat:write", "usage:read", "keys:manage", "providers:manage"]),
    };
  }
}

export function initializeRouterFirebase(projectId: string): App {
  const existing = getApps().find((candidate) => candidate.name === "wan-router");
  if (existing) return existing;

  const options = process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? { projectId }
    : { projectId, credential: applicationDefault() };
  return initializeApp(options, "wan-router");
}

export function createFirebaseAuthenticator(projectId: string, repository: RouterRepository): FirebaseIdTokenAuthenticator {
  return new FirebaseIdTokenAuthenticator(
    getAuth(initializeRouterFirebase(projectId)),
    new RepositoryWorkspaceResolver(repository),
  );
}