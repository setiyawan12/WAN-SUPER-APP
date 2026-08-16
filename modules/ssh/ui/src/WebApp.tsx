import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ChevronDown, FileKey2, KeyRound, LoaderCircle, LogOut, PlugZap, RotateCw, Server, ShieldCheck, Square, TerminalSquare, Unplug, X } from "lucide-react";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import type { SshTransportEvent } from "./transport/contract";
import { GatewayClientError, WebSocketRemoteTerminalTransport, type GatewayTokenProvider } from "./transport/web-socket";
import { getKnownHost, saveKnownHost } from "./web-known-hosts";

type GatewayStatus = "checking" | "online" | "auth-required" | "incompatible" | "unavailable" | "lost";
type WebSession = { id: string; label: string; state: string; reason?: string; message?: string };
type HostKeyPrompt = Extract<SshTransportEvent, { type: "hostkey.prompt" }>;
type AuthPrompt = Extract<SshTransportEvent, { type: "auth.prompt" }>;
type AuthenticationMethod = "password" | "privateKey";

const MAX_PRIVATE_KEY_BYTES = 256 * 1024;

type WebAccount = { uid: string; displayName?: string; email?: string; photoURL?: string };

type WebAppProps = {
  tokenProvider?: GatewayTokenProvider;
  account?: WebAccount;
  onSignOut?: () => Promise<void>;
};

function accountLabel(account: WebAccount) {
  return account.displayName || account.email || "WAN user";
}

function AccountAvatar({ account }: { account: WebAccount }) {
  if (account.photoURL) {
    return <img className="web-account-avatar" src={account.photoURL} alt="" referrerPolicy="no-referrer" />;
  }
  return <i className="web-account-avatar" aria-hidden="true">{accountLabel(account).slice(0, 1).toUpperCase()}</i>;
}

function statusLabel(status: GatewayStatus) {
  switch (status) {
    case "checking": return "Checking gateway";
    case "online": return "Gateway online";
    case "auth-required": return "Gateway authentication required";
    case "incompatible": return "Gateway version incompatible";
    case "unavailable": return "Gateway unavailable";
    case "lost": return "Connection lost";
  }
}

function statusTone(status: GatewayStatus) {
  if (status === "online") return "ok";
  if (status === "checking" || status === "auth-required") return "warn";
  return "danger";
}

export default function WebApp({ tokenProvider, account, onSignOut }: WebAppProps) {
  const [transport] = useState(() => new WebSocketRemoteTerminalTransport(window.location.origin, tokenProvider));
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [gatewayVersion, setGatewayVersion] = useState<string>();
  const [host, setHost] = useState("172.16.88.17");
  const [port, setPort] = useState(2244);
  const [username, setUsername] = useState("");
  const [authenticationMethod, setAuthenticationMethod] = useState<AuthenticationMethod>("password");
  const [privateKeyFile, setPrivateKeyFile] = useState<File>();
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<WebSession>();
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt>();
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt>();
  const [authAnswers, setAuthAnswers] = useState<string[]>([]);
  const [signingOut, setSigningOut] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<TerminalHandle>(null);

  const checkGateway = async () => {
    setGatewayStatus("checking");
    try {
      const health = await transport.health();
      setGatewayVersion(health.version);
      setGatewayStatus("online");
    } catch (cause) {
      const code = cause instanceof GatewayClientError ? cause.code : "GATEWAY_UNAVAILABLE";
      setGatewayStatus(code === "AUTH_REQUIRED" ? "auth-required" : code === "PROTOCOL_UNSUPPORTED" ? "incompatible" : "unavailable");
    }
  };

  useEffect(() => {
    void checkGateway();
    const off = transport.onEvent((event) => {
      if (event.type === "session.state") {
        setSession((current) => current?.id === event.sessionId ? { ...current, state: event.state, reason: event.reason, message: event.message } : current);
        if (event.reason === "CONNECTION_LOST" || event.reason === "SERVICE_RESTART") setGatewayStatus("lost");
      } else if (event.type === "session.exit") {
        setSession((current) => current?.id === event.sessionId ? { ...current, state: "disconnected", reason: event.reason, message: event.message } : current);
      } else if (event.type === "hostkey.prompt") {
        setHostKeyPrompt(event);
      } else if (event.type === "auth.prompt") {
        setAuthAnswers(event.prompts.map(() => ""));
        setAuthPrompt(event);
      }
    });
    return () => {
      off();
      transport.dispose();
    };
  }, [transport]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && accountMenuRef.current?.contains(event.target as Node)) return;
      setAccountMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [accountMenuOpen]);

  const clearCredentialFields = () => {
    setPrivateKeyFile(undefined);
    setPassphrase("");
    setPassword("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const selectAuthenticationMethod = (method: AuthenticationMethod) => {
    clearCredentialFields();
    setError(undefined);
    setAuthenticationMethod(method);
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (authenticationMethod === "password" && !password) return setError("Enter the SSH account password");
    if (authenticationMethod === "privateKey" && !privateKeyFile) return setError("Select a private key file");
    if (privateKeyFile && privateKeyFile.size > MAX_PRIVATE_KEY_BYTES) return setError("Private key exceeds the 256 KiB limit");
    setConnecting(true);
    try {
      const knownHost = await getKnownHost(host, port).catch(() => undefined);
      const authentication = authenticationMethod === "password"
        ? { method: "password" as const, password }
        : { method: "privateKey" as const, privateKey: await privateKeyFile!.text(), ...(passphrase ? { passphrase } : {}) };
      const pending = transport.open({
        target: { host: host.trim(), port, username: username.trim() },
        terminal: { cols: terminalRef.current?.dimensions().cols ?? 100, rows: terminalRef.current?.dimensions().rows ?? 32, term: "xterm-256color" },
        authentication,
        expectedHostKeyFingerprint: knownHost?.fingerprint
      });
      clearCredentialFields();
      const opened = await pending;
      setSession({ id: opened.sessionId, label: `${username.trim()}@${host.trim()}`, state: "connecting" });
      setGatewayStatus("online");
    } catch (cause) {
      const clientError = cause instanceof GatewayClientError ? cause : undefined;
      if (clientError?.code === "AUTH_REQUIRED") setGatewayStatus("auth-required");
      else if (clientError?.code === "PROTOCOL_UNSUPPORTED") setGatewayStatus("incompatible");
      else if (clientError?.code === "CONNECTION_LOST" || clientError?.code === "GATEWAY_UNAVAILABLE") setGatewayStatus("unavailable");
      setError(cause instanceof Error ? cause.message : String(cause));
      clearCredentialFields();
    } finally {
      setConnecting(false);
    }
  };

  const answerHostKey = async (accept: boolean) => {
    const prompt = hostKeyPrompt;
    if (!prompt) return;
    setHostKeyPrompt(undefined);
    if (accept) {
      try {
        await saveKnownHost({ host: prompt.host, port: prompt.port, algorithm: prompt.algorithm, fingerprint: prompt.fingerprint });
      } catch {
        setError("Host fingerprint could not be saved in this browser profile");
        transport.answerHostKey(prompt.sessionId, false);
        return;
      }
    }
    transport.answerHostKey(prompt.sessionId, accept);
  };

  const answerAuthentication = (submit: boolean) => {
    if (!authPrompt) return;
    if (submit) transport.answerAuthPrompt(authPrompt.sessionId, authAnswers);
    else void transport.close(authPrompt.sessionId);
    setAuthAnswers([]);
    setAuthPrompt(undefined);
  };

  const reconnectGateway = async () => {
    setError(undefined);
    setSession(undefined);
    setHostKeyPrompt(undefined);
    setAuthPrompt(undefined);
    setGatewayStatus("checking");
    try {
      await transport.reconnect();
      const health = await transport.health();
      setGatewayVersion(health.version);
      setGatewayStatus("online");
    } catch (cause) {
      const code = cause instanceof GatewayClientError ? cause.code : "GATEWAY_UNAVAILABLE";
      setGatewayStatus(code === "AUTH_REQUIRED" ? "auth-required" : code === "PROTOCOL_UNSUPPORTED" ? "incompatible" : "unavailable");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const closeSession = async () => {
    if (!session) return;
    const closing = session.id;
    setSession(undefined);
    setHostKeyPrompt(undefined);
    setAuthPrompt(undefined);
    await transport.close(closing).catch(() => undefined);
  };

  const signOut = async () => {
    if (!onSignOut || signingOut) return;
    setSigningOut(true);
    setAccountMenuOpen(false);
    setSession(undefined);
    setHostKeyPrompt(undefined);
    setAuthPrompt(undefined);
    transport.disconnect("User signed out");
    try {
      await onSignOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSigningOut(false);
    }
  };

  return (
    <div className="web-ssh-app">
      <header className="web-topbar">
        <div className="web-product-mark"><span>W</span><div><strong>WAN SSH</strong><small>Web Gateway</small></div></div>
        <div className="web-gateway-status"><span className={`status-dot ${statusTone(gatewayStatus)}`} /><strong>{statusLabel(gatewayStatus)}</strong>{gatewayVersion && <small>v{gatewayVersion}</small>}</div>
        {account && (
          <div className="web-account-menu" ref={accountMenuRef}>
            <button className="web-account" type="button" aria-haspopup="menu" aria-expanded={accountMenuOpen} title={account.email || accountLabel(account)} onClick={() => setAccountMenuOpen((open) => !open)}>
              <AccountAvatar account={account} />
              <span>{accountLabel(account)}</span>
              <ChevronDown size={13} />
            </button>
            {accountMenuOpen && (
              <div className="web-account-panel" role="menu">
                <div className="web-account-identity">
                  <AccountAvatar account={account} />
                  <div>
                    <strong>{accountLabel(account)}</strong>
                    {account.email && <small>{account.email}</small>}
                    <code>{account.uid}</code>
                  </div>
                </div>
                {onSignOut && (
                  <button className="web-account-action" type="button" role="menuitem" title="Sign out" aria-label="Sign out" onClick={() => void signOut()} disabled={signingOut}>
                    <LogOut size={14} />{signingOut ? "Signing out..." : "Sign out"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <button className="icon-button" type="button" title="Check gateway" onClick={() => void checkGateway()} disabled={gatewayStatus === "checking"}><RotateCw size={15} className={gatewayStatus === "checking" ? "spin" : ""} /></button>
      </header>

      <main className="web-ssh-workspace">
        <aside className="web-connect-panel">
          <div className="web-panel-heading"><PlugZap size={17} /><div><strong>Quick connect</strong><small>Remote SSH terminal</small></div></div>
          <form className="web-connect-form" onSubmit={connect}>
            <label className="field"><span>Host</span><div className="web-input-icon"><Server size={14} /><input value={host} maxLength={253} required autoComplete="off" onChange={(event) => setHost(event.target.value)} /></div></label>
            <div className="web-form-row">
              <label className="field"><span>Port</span><input type="number" min={1} max={65535} value={port} required onChange={(event) => setPort(Number(event.target.value))} /></label>
              <label className="field"><span>Username</span><input value={username} maxLength={128} required autoComplete="username" onChange={(event) => setUsername(event.target.value)} /></label>
            </div>
            <div className="field"><span>Authentication</span><div className="segmented web-auth-method" role="group" aria-label="SSH authentication method"><button type="button" aria-pressed={authenticationMethod === "password"} onClick={() => selectAuthenticationMethod("password")}><KeyRound size={13} />Password</button><button type="button" aria-pressed={authenticationMethod === "privateKey"} onClick={() => selectAuthenticationMethod("privateKey")}><FileKey2 size={13} />Private key</button></div></div>
            {authenticationMethod === "password" ? (
              <label className="field"><span>Password</span><div className="web-input-icon"><KeyRound size={14} /><input type="password" value={password} maxLength={4096} required autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></div></label>
            ) : <>
              <label className="field"><span>Private key</span><span className={`web-file-picker ${privateKeyFile ? "selected" : ""}`}><FileKey2 size={17} /><span>{privateKeyFile ? <><strong>{privateKeyFile.name}</strong><small>{Math.ceil(privateKeyFile.size / 1024)} KiB</small></> : <><strong>Select key file</strong><small>Maximum 256 KiB</small></>}</span><input ref={fileInputRef} type="file" required onChange={(event) => { const file = event.target.files?.[0]; setPrivateKeyFile(file); setError(file && file.size > MAX_PRIVATE_KEY_BYTES ? "Private key exceeds the 256 KiB limit" : undefined); }} /></span></label>
              <label className="field"><span>Passphrase <small>optional</small></span><div className="web-input-icon"><KeyRound size={14} /><input type="password" value={passphrase} maxLength={4096} autoComplete="off" onChange={(event) => setPassphrase(event.target.value)} /></div></label>
            </>}
            {error && <div className="web-inline-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button type="button" title="Dismiss error" onClick={() => setError(undefined)}><X size={14} /></button></div>}
            <button className="button primary large full" type="submit" disabled={connecting || (authenticationMethod === "password" ? !password : !privateKeyFile || privateKeyFile.size > MAX_PRIVATE_KEY_BYTES) || !host.trim() || !username.trim() || gatewayStatus === "incompatible"}>
              {connecting ? <LoaderCircle size={16} className="spin" /> : <TerminalSquare size={16} />}{connecting ? "Connecting" : "Connect"}
            </button>
          </form>
          <div className="web-security-state"><ShieldCheck size={15} /><span>SSH credentials are session-only</span></div>
        </aside>

        <section className="web-terminal-workspace">
          <div className="web-terminal-toolbar">
            <div><span className={`status-dot ${session?.state === "connected" ? "ok" : session ? "warn" : "muted"}`} /><strong>{session?.label ?? "No active session"}</strong>{session && <small>{session.state}</small>}</div>
            {session && <button className="icon-button danger" type="button" title="Close session" onClick={() => void closeSession()}><Square size={14} /></button>}
          </div>
          <div className="web-terminal-stage">
            {session ? (
              <TerminalPane ref={terminalRef} sessionId={session.id} visible active label={session.label} transport={transport} />
            ) : (
              <div className="web-terminal-empty"><TerminalSquare size={34} /><strong>Remote terminal</strong><span>{gatewayStatus === "online" ? "Ready for a connection" : statusLabel(gatewayStatus)}</span></div>
            )}
            {session && ["error", "disconnected", "closed"].includes(session.state) && <div className="disconnect-banner"><Unplug size={16} /><span>{session.message ?? session.reason ?? "Session disconnected"}</span><div className="web-prompt-actions"><button className="button compact" type="button" onClick={() => void reconnectGateway()}>Reconnect socket</button><button className="button compact" type="button" onClick={() => void closeSession()}>Close</button></div></div>}
          </div>
        </section>
      </main>

      <footer className="web-statusbar"><span><ShieldCheck size={12} /> Host-key verification active</span><span className="status-spacer" /><span>{session ? "1 active session" : "0 active sessions"}</span></footer>

      {hostKeyPrompt && <div className="modal-backdrop"><div className={`web-prompt-dialog ${hostKeyPrompt.kind === "changed" ? "danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby="hostkey-title"><div className="web-prompt-icon"><ShieldCheck size={22} /></div><small>{hostKeyPrompt.kind === "changed" ? "Host identity changed" : "Unknown host"}</small><h2 id="hostkey-title">Verify SSH host key</h2><dl><div><dt>Host</dt><dd>{hostKeyPrompt.host}:{hostKeyPrompt.port}</dd></div><div><dt>Algorithm</dt><dd>{hostKeyPrompt.algorithm}</dd></div>{hostKeyPrompt.previousFingerprint && <div><dt>Previous</dt><dd>{hostKeyPrompt.previousFingerprint}</dd></div>}<div><dt>Observed</dt><dd>{hostKeyPrompt.fingerprint}</dd></div></dl><div className="web-prompt-actions"><button className="button" type="button" onClick={() => void answerHostKey(false)}>Reject</button><button className={hostKeyPrompt.kind === "changed" ? "button danger" : "button primary"} type="button" onClick={() => void answerHostKey(true)}>Accept</button></div></div></div>}

      {authPrompt && <div className="modal-backdrop"><div className="web-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title"><div className="web-prompt-icon"><KeyRound size={22} /></div><small>SSH authentication</small><h2 id="auth-title">Additional verification</h2><div className="web-auth-prompts">{authPrompt.prompts.map((prompt, index) => <label className="field" key={`${prompt.prompt}-${index}`}><span>{prompt.prompt || `Answer ${index + 1}`}</span><input type={prompt.echo ? "text" : "password"} value={authAnswers[index] ?? ""} autoFocus={index === 0} onChange={(event) => setAuthAnswers((current) => current.map((value, answerIndex) => answerIndex === index ? event.target.value : value))} /></label>)}</div><div className="web-prompt-actions"><button className="button" type="button" onClick={() => answerAuthentication(false)}>Cancel</button><button className="button primary" type="button" onClick={() => answerAuthentication(true)}>Continue</button></div></div></div>}
    </div>
  );
}