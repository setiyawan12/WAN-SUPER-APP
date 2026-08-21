import { writeStore, type AgentStore } from "./pairing.js";

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
const REFRESH_SKEW_MS = 5 * 60_000;
const FATAL_REASONS = new Set(["TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN", "INVALID_GRANT_TYPE", "MISSING_REFRESH_TOKEN"]);

export class AgentAuthError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
    this.name = "AgentAuthError";
  }
}

export interface TokenSource {
  readonly mode: "firebase" | "dev-anonymous";
  get(force?: boolean): Promise<string | undefined>;
  expiresAt(): number | undefined;
}

type SecureTokenResponse = {
  id_token?: string;
  refresh_token?: string;
  expires_in?: string;
  error?: { message?: string };
};

/**
 * Agent tidak punya sesi browser, jadi ID token dicetak ulang dari refresh
 * token lewat endpoint Secure Token. Refresh token yang dirotasi Google
 * ditulis balik ke file pairing supaya agent tetap hidup lintas restart
 * tanpa pairing ulang.
 */
export function createTokenSource(store: AgentStore, persist: (next: AgentStore) => void = (next) => void writeStore(next)): TokenSource {
  if (store.mode === "dev-anonymous") {
    return { mode: "dev-anonymous", async get() { return undefined; }, expiresAt() { return undefined; } };
  }
  const endpoint = `${store.tokenUrl ?? SECURE_TOKEN_URL}?key=${encodeURIComponent(store.apiKey!)}`;
  let refreshToken = store.refreshToken!;
  let idToken: string | undefined;
  let expiry = 0;
  let inFlight: Promise<string> | undefined;

  const exchange = async () => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
      });
    } catch (error) {
      throw new AgentAuthError(`Firebase token endpoint is unreachable: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    const payload = await response.json().catch(() => ({})) as SecureTokenResponse;
    if (!response.ok || !payload.id_token) {
      const reason = payload.error?.message ?? `HTTP ${response.status}`;
      throw new AgentAuthError(`Firebase refused the agent refresh token: ${reason}`, FATAL_REASONS.has(reason.split(" ")[0]));
    }
    idToken = payload.id_token;
    expiry = Date.now() + Math.max(60, Number(payload.expires_in ?? 3_600)) * 1_000;
    if (payload.refresh_token && payload.refresh_token !== refreshToken) {
      refreshToken = payload.refresh_token;
      persist({ ...store, refreshToken });
    }
    return idToken;
  };

  return {
    mode: "firebase",
    async get(force = false) {
      if (!force && idToken && Date.now() < expiry - REFRESH_SKEW_MS) return idToken;
      inFlight ??= exchange().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    expiresAt() {
      return expiry || undefined;
    }
  };
}
