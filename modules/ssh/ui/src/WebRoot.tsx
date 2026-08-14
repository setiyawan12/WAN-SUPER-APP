import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, LoaderCircle, ShieldCheck, TerminalSquare } from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import WebApp from "./WebApp";
import { loadGatewayRuntimeConfig, type GatewayRuntimeConfig } from "./transport/web-socket";
import { resetWebSshPassword, signInWebSsh, signOutWebSsh, webFirebaseServices } from "./web-firebase";

function authenticationMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("invalid-credential")) return "Email or password is incorrect.";
  if (code.includes("too-many-requests")) return "Too many sign-in attempts. Try again later.";
  if (code.includes("network-request-failed")) return "Firebase Authentication is unreachable.";
  return error instanceof Error ? error.message : String(error);
}

function AuthGate({ emulator }: { emulator: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    setSuccess(false);
    try {
      await action();
    } catch (error) {
      setMessage(authenticationMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!email.trim()) {
      setMessage("Enter your email first.");
      return;
    }
    await run(async () => {
      await resetWebSshPassword(email.trim());
      setSuccess(true);
      setMessage("Password reset email sent.");
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => signInWebSsh(email.trim(), password));
  };

  return (
    <main className="web-auth-layout">
      <section className="web-auth-context" aria-label="WAN SSH identity">
        <div className="web-auth-brand"><span>W</span><div><strong>WAN SSH</strong><small>WEB GATEWAY</small></div></div>
        <div className="web-auth-title"><span><ShieldCheck size={14} />Production access</span><h1>Remote terminal,<br />verified identity.</h1><p>Sign in with an authorized WAN account.</p></div>
        <small>{emulator ? "Firebase Auth emulator" : "Firebase Authentication"}</small>
      </section>
      <section className="web-auth-form-panel">
        <form className="web-auth-form" onSubmit={submit}>
          <div className="web-auth-form-head"><TerminalSquare size={21} /><div><small>WAN SSH CLOUD</small><h2>Sign in</h2></div></div>
          <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {message && <p className={success ? "web-auth-message success" : "web-auth-message"}><AlertTriangle size={14} />{message}</p>}
          <button className="button primary large full" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{busy ? "Signing in" : "Sign in"}</button>
          <button className="web-auth-reset" type="button" disabled={busy} onClick={() => void resetPassword()}>Reset password</button>
        </form>
      </section>
    </main>
  );
}

export default function WebRoot() {
  const [runtimeConfig, setRuntimeConfig] = useState<GatewayRuntimeConfig>();
  const [user, setUser] = useState<User | null>(null);
  const [emulator, setEmulator] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void loadGatewayRuntimeConfig()
      .then(async (config) => {
        if (!active) return;
        setRuntimeConfig(config);
        if (config.authMode === "dev-anonymous") {
          setLoading(false);
          return;
        }
        const services = await webFirebaseServices();
        if (!active) return;
        setEmulator(services.emulator);
        unsubscribe = onAuthStateChanged(services.auth, (nextUser) => {
          if (!active) return;
          setUser(nextUser);
          setLoading(false);
        });
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (loading) return <div className="web-auth-boot"><LoaderCircle size={22} className="spin" /><strong>Connecting WAN SSH</strong></div>;
  if (error || !runtimeConfig) return <div className="web-auth-boot error"><AlertTriangle size={24} /><strong>SSH web runtime unavailable</strong><span>{error || "Gateway configuration is unavailable."}</span></div>;
  if (runtimeConfig.authMode === "dev-anonymous") return <WebApp />;
  if (!user) return <AuthGate emulator={emulator} />;
  return (
    <WebApp
      key={user.uid}
      account={{ displayName: user.displayName ?? undefined, email: user.email ?? undefined }}
      tokenProvider={(forceRefresh) => user.getIdToken(forceRefresh)}
      onSignOut={signOutWebSsh}
    />
  );
}