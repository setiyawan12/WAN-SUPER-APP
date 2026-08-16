import { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { SshWorkspace } from "./App";
import { installRuntimeApi } from "./api";
import WebApp from "./WebApp";
import WebLogin from "./WebLogin";
import { useWebAuthSession } from "./web-auth";
import { WebCloudApi } from "./web-cloud-api";
import { WebCloudStore } from "./web-cloud-store";
import { webFirebaseServices } from "./web-firebase";
import { DASHBOARD_ROUTE, LOGIN_ROUTE, navigateRoute, useRoute } from "./web-router";
import { WebSocketRemoteTerminalTransport } from "./transport/web-socket";

function BootScreen() {
  return <div className="web-auth-boot"><LoaderCircle size={22} className="spin" /><strong>Connecting WAN SSH</strong></div>;
}

function CloudWorkspace({ session }: { session: ReturnType<typeof useWebAuthSession> }) {
  const [runtime, setRuntime] = useState<WebCloudApi>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let cloudApi: WebCloudApi | undefined;
    void webFirebaseServices().then(async (services) => {
      if (!services.database || !session.account) throw new Error("Firebase Realtime Database is required for the WAN SSH cloud workspace.");
      const transport = new WebSocketRemoteTerminalTransport(window.location.origin, session.getIdToken);
      const store = new WebCloudStore(services.database, session.account.uid);
      cloudApi = new WebCloudApi(store, transport, session.account.email || session.account.displayName || session.account.uid, session.signOut);
      await cloudApi.initialize();
      if (!active) {
        cloudApi.dispose();
        return;
      }
      installRuntimeApi(cloudApi);
      setRuntime(cloudApi);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      cloudApi?.dispose();
    };
  }, [session.account?.uid, session.getIdToken, session.signOut]);

  if (error) return <div className="web-auth-boot error"><AlertTriangle size={24} /><strong>Cloud workspace unavailable</strong><span>{error}</span></div>;
  if (!runtime || !session.account) return <BootScreen />;
  return <SshWorkspace
    transport={runtime.transport}
    capabilities={{ ...runtime.transport.capabilities, runtime: "web-cloud" }}
    account={session.account}
    onSignOut={session.signOut}
  />;
}

export default function WebRoot() {
  const session = useWebAuthSession();
  const route = useRoute();

  // Guard rute: seluruh path internal terproteksi. Belum login diarahkan ke
  // `/login`, sudah login selalu berakhir di `/dashboard`.
  useEffect(() => {
    if (session.status === "loading" || session.error) return;
    if (session.status === "unauthenticated") {
      if (route !== LOGIN_ROUTE) navigateRoute(LOGIN_ROUTE, true);
      return;
    }
    if (route !== DASHBOARD_ROUTE) navigateRoute(DASHBOARD_ROUTE, true);
  }, [session.status, session.error, route]);

  if (session.status === "loading") return <BootScreen />;
  if (session.error || !session.runtimeConfig) {
    return (
      <div className="web-auth-boot error">
        <AlertTriangle size={24} />
        <strong>SSH web runtime unavailable</strong>
        <span>{session.error || "Gateway configuration is unavailable."}</span>
      </div>
    );
  }
  if (session.status === "unauthenticated") {
    return route === LOGIN_ROUTE ? <WebLogin emulator={session.emulator} /> : <BootScreen />;
  }
  if (route !== DASHBOARD_ROUTE) return <BootScreen />;
  if (session.runtimeConfig.authMode === "dev-anonymous") return <WebApp />;
  return <CloudWorkspace key={session.account?.uid} session={session} />;
}
