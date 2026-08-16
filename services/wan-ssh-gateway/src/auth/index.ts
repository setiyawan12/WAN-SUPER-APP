import type { GatewayConfig } from "../config.js";
import { CLOSE_CODES, GatewayError } from "../errors.js";
import type { AuthMessage } from "../protocol.js";
import { createFirebaseAuthenticator } from "./firebase.js";
import type { Principal } from "./principal.js";

export interface Authenticator {
  authenticate(message: AuthMessage): Promise<Principal>;
  refresh(principal: Principal, token: string): Promise<Principal>;
}

function createDevelopmentAuthenticator(): Authenticator {
  return {
    async authenticate(message) {
      if (message.mode !== "dev-anonymous") throw new GatewayError("AUTH_INVALID", "Authentication mode mismatch", false, CLOSE_CODES.authInvalid);
      return { kind: "development", id: "development:local-browser", uid: "local-browser", tenantId: "development" };
    },
    async refresh() {
      throw new GatewayError("AUTH_INVALID", "Authentication refresh is unavailable", false, CLOSE_CODES.authInvalid);
    }
  };
}

export function createAuthenticator(config: GatewayConfig): Authenticator {
  return config.authMode === "firebase"
    ? createFirebaseAuthenticator(config.firebaseProjectId!)
    : createDevelopmentAuthenticator();
}

export function assertSamePrincipal(current: Principal, refreshed: Principal) {
  if (current.id !== refreshed.id) throw new GatewayError("AUTH_INVALID", "Authentication principal changed", false, CLOSE_CODES.authInvalid);
}