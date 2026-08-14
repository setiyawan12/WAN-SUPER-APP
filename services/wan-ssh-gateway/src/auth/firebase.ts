import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { CLOSE_CODES, GatewayError } from "../errors.js";
import type { Authenticator } from "./index.js";
import type { Principal } from "./principal.js";

const FIREBASE_APP_NAME = "wan-ssh-gateway";

export function initializeGatewayFirebase(projectId: string): App {
  const existing = getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME);
  if (existing) return existing;
  const options = process.env.FIREBASE_AUTH_EMULATOR_HOST
    ? { projectId }
    : { credential: applicationDefault(), projectId };
  return initializeApp(options, FIREBASE_APP_NAME);
}

export function createFirebaseAuthenticator(projectId: string): Authenticator {
  const app = initializeGatewayFirebase(projectId);
  const verify = async (token: string): Promise<Principal> => {
    try {
      const claims = await getAuth(app).verifyIdToken(token, true);
      return {
        kind: "firebase",
        id: `firebase:${claims.uid}`,
        uid: claims.uid,
        email: typeof claims.email === "string" ? claims.email : undefined,
        expiresAt: claims.exp * 1_000
      };
    } catch {
      throw new GatewayError("AUTH_INVALID", "Authentication token was rejected", false, CLOSE_CODES.authInvalid);
    }
  };
  return {
    async authenticate(message) {
      if (message.mode !== "firebase" || !message.token) throw new GatewayError("AUTH_INVALID", "Authentication mode mismatch", false, CLOSE_CODES.authInvalid);
      return verify(message.token);
    },
    async refresh(_principal, token) {
      return verify(token);
    }
  };
}