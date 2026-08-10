import assert from "node:assert/strict";
import { test } from "node:test";
import type { Auth } from "firebase-admin/auth";
import { FirebaseIdTokenAuthenticator, type WorkspaceResolver } from "../src/auth/firebase.js";
import { GatewayError } from "../src/errors.js";

function requestWithBearer(token: string) {
  return {
    header(name: string) {
      return name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined;
    },
  };
}

test("Firebase token failures remain 401 authentication errors", async () => {
  const auth = {
    verifyIdToken: async () => { throw new Error("bad token"); },
  } as unknown as Auth;
  const resolver: WorkspaceResolver = { resolvePersonalWorkspace: async () => "workspace_never" };
  const authenticator = new FirebaseIdTokenAuthenticator(auth, resolver);

  await assert.rejects(
    authenticator.authenticate(requestWithBearer("bad") as never),
    (error: unknown) => error instanceof GatewayError && error.status === 401 && error.code === "invalid_firebase_token",
  );
});

test("workspace repository outages become 503 instead of false token failures", async () => {
  const auth = {
    verifyIdToken: async () => ({ uid: "firebase_uid" }),
  } as unknown as Auth;
  const resolver: WorkspaceResolver = {
    resolvePersonalWorkspace: async () => { throw new Error("database unavailable"); },
  };
  const authenticator = new FirebaseIdTokenAuthenticator(auth, resolver);

  await assert.rejects(
    authenticator.authenticate(requestWithBearer("valid") as never),
    (error: unknown) => error instanceof GatewayError
      && error.status === 503
      && error.code === "tenant_resolution_unavailable",
  );
});