import { useCallback, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { loadGatewayRuntimeConfig, type GatewayRuntimeConfig, type GatewayTokenProvider } from "./transport/web-socket";
import { signOutWebSsh, webFirebaseServices } from "./web-firebase";

export type WebAuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface WebAuthAccount {
  uid: string;
  displayName?: string;
  email?: string;
  photoURL?: string;
}

export interface WebAuthSession {
  status: WebAuthStatus;
  runtimeConfig?: GatewayRuntimeConfig;
  account?: WebAuthAccount;
  emulator: boolean;
  error: string;
  getIdToken: GatewayTokenProvider;
  signOut(): Promise<void>;
}

function accountOf(user: User): WebAuthAccount {
  return {
    uid: user.uid,
    displayName: user.displayName ?? undefined,
    email: user.email ?? undefined,
    photoURL: user.photoURL ?? undefined
  };
}

/**
 * State autentikasi global untuk web gateway. Status tetap `loading` sampai
 * runtime config gateway terbaca dan Firebase menyelesaikan pengecekan sesi,
 * sehingga halaman login tidak pernah berkedip di depan sesi yang masih valid.
 * Mode gateway `dev-anonymous` tidak memakai Firebase dan langsung dianggap
 * authenticated tanpa akun.
 */
export function useWebAuthSession(): WebAuthSession {
  const [runtimeConfig, setRuntimeConfig] = useState<GatewayRuntimeConfig>();
  const [status, setStatus] = useState<WebAuthStatus>("loading");
  const [account, setAccount] = useState<WebAuthAccount>();
  const [emulator, setEmulator] = useState(false);
  const [error, setError] = useState("");
  const userRef = useRef<User | null>(null);

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void loadGatewayRuntimeConfig()
      .then(async (config) => {
        if (!active) return;
        setRuntimeConfig(config);
        if (config.authMode === "dev-anonymous") {
          setStatus("authenticated");
          return;
        }
        const services = await webFirebaseServices();
        if (!active) return;
        setEmulator(services.emulator);
        unsubscribe = onAuthStateChanged(services.auth, (user) => {
          if (!active) return;
          userRef.current = user;
          setAccount(user ? accountOf(user) : undefined);
          setStatus(user ? "authenticated" : "unauthenticated");
        });
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("unauthenticated");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const getIdToken = useCallback<GatewayTokenProvider>(async (forceRefresh) => {
    const user = userRef.current;
    if (!user) throw new Error("Sign in to use the WAN SSH gateway.");
    return user.getIdToken(forceRefresh);
  }, []);

  return {
    status,
    runtimeConfig,
    account,
    emulator,
    error,
    getIdToken,
    signOut: signOutWebSsh
  };
}
