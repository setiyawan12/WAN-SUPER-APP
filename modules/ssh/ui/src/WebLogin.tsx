import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, LoaderCircle, ShieldCheck, TerminalSquare } from "lucide-react";
import { resetWebSshPassword, resumeWebSshGoogleRedirect, signInWebSsh, signInWebSshGoogle } from "./web-firebase";

type PendingAction = "google" | "password" | "reset";

function authenticationMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("invalid-credential")) return "Email or password is incorrect.";
  if (code.includes("too-many-requests")) return "Too many sign-in attempts. Try again later.";
  if (code.includes("network-request-failed")) return "Firebase Authentication is unreachable.";
  if (code.includes("popup-closed-by-user") || code.includes("cancelled-popup-request")) return "Google sign-in was cancelled.";
  if (code.includes("popup-blocked")) return "Your browser blocked the Google popup. Allow popups for this site and try again.";
  if (code.includes("operation-not-allowed")) return "Google sign-in is not enabled for this Firebase project.";
  if (code.includes("unauthorized-domain")) return "This domain is not authorized for Google sign-in in Firebase.";
  if (code.includes("account-exists-with-different-credential")) return "This email already uses another sign-in method. Sign in with your password first.";
  if (code.includes("user-disabled")) return "This WAN account is disabled.";
  return error instanceof Error ? error.message : String(error);
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#4285f4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.8-2 5.1-4.4 6.7v5.5h7.1c4.1-3.8 6.6-9.5 6.6-16.4z" />
      <path fill="#34a853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.4v5.7C8 41.1 15.4 46 24 46z" />
      <path fill="#fbbc05" d="M11.7 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.4A21.9 21.9 0 0 0 2 24c0 3.6.8 6.9 2.4 9.9l7.3-5.7z" />
      <path fill="#ea4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.4 2 8 6.9 4.4 14.1l7.3 5.7c1.7-5.2 6.6-9.1 12.3-9.1z" />
    </svg>
  );
}

export default function WebLogin({ emulator }: { emulator: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<PendingAction>();
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const pendingRef = useRef(false);

  // Redirect flow dipakai saat popup Google diblokir browser; hasilnya dibaca
  // sekali saat halaman kembali dari Google.
  useEffect(() => {
    let active = true;
    void resumeWebSshGoogleRedirect().catch((error) => {
      if (active) setMessage(authenticationMessage(error));
    });
    return () => {
      active = false;
    };
  }, []);

  const busy = pending !== undefined;

  const run = async (action: PendingAction, task: () => Promise<unknown>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setMessage("");
    setSuccess(false);
    try {
      await task();
    } catch (error) {
      setMessage(authenticationMessage(error));
    } finally {
      pendingRef.current = false;
      setPending(undefined);
    }
  };

  const resetPassword = async () => {
    if (!email.trim()) {
      setMessage("Enter your email first.");
      return;
    }
    await run("reset", async () => {
      await resetWebSshPassword(email.trim());
      setSuccess(true);
      setMessage("Password reset email sent.");
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run("password", () => signInWebSsh(email.trim(), password));
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
          <button className="web-auth-google" type="button" disabled={busy} onClick={() => void run("google", signInWebSshGoogle)}>
            {pending === "google" ? <LoaderCircle size={16} className="spin" /> : <GoogleMark />}
            {pending === "google" ? "Signing in..." : "Continue with Google"}
          </button>
          <div className="web-auth-divider"><span>or use email</span></div>
          <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {message && <p className={success ? "web-auth-message success" : "web-auth-message"} role={success ? undefined : "alert"}><AlertTriangle size={14} />{message}</p>}
          <button className="button primary large full" type="submit" disabled={busy}>{pending === "password" ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{pending === "password" ? "Signing in..." : "Sign in"}</button>
          <button className="web-auth-reset" type="button" disabled={busy} onClick={() => void resetPassword()}>Reset password</button>
        </form>
      </section>
    </main>
  );
}
