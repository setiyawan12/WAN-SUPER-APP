import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  Bot,
  Boxes,
  Cloud,
  KeyRound,
  LogOut,
  Menu,
  Plug,
  RefreshCw,
  Send,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import type { ChatStreamHandle } from "../renderer/transport/chat";
import { chatTransport } from "../renderer/transport/runtime";
import type { ChatStreamEvent, ChatUsage } from "../renderer/wan";
import {
  getCloudRuntimeCapabilities,
  getCloudUsage,
  listCloudModels,
  listRecentCloudGenerations,
  type CloudGeneration,
  type CloudModel,
  type CloudProvider,
  type CloudUsage,
} from "./api";
import {
  createAccount,
  firebaseServices,
  sendReset,
  signInEmail,
  signInGoogle,
  signOutWan,
} from "./firebase";
import { WebMarkdown } from "./WebMarkdown";
import { ApiKeysView } from "./ApiKeysView";
import { ProvidersView } from "./ProvidersView";

type ViewId = "chat" | "models" | "providers" | "usage" | "keys";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: string;
  usage?: ChatUsage;
}

function authMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("invalid-credential")) return "Email or password is incorrect.";
  if (code.includes("email-already-in-use")) return "This email already has an account.";
  if (code.includes("weak-password")) return "Use a stronger password with at least 6 characters.";
  if (code.includes("network-request-failed")) return "Firebase Authentication is unreachable.";
  if (code.includes("popup-closed-by-user")) return "Google sign-in was cancelled.";
  return error instanceof Error ? error.message : String(error);
}

function AuthGate() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [emulator, setEmulator] = useState(false);

  useEffect(() => {
    void firebaseServices().then((services) => setEmulator(services.emulator));
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    setSuccess(false);
    try {
      await action();
    } catch (error) {
      setMessage(authMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!email.trim()) {
      setMessage("Enter your email first.");
      return;
    }
    await run(async () => {
      await sendReset(email.trim());
      setSuccess(true);
      setMessage("Password reset email sent.");
    });
  }

  return (
    <main className="auth-layout">
      <section className="auth-context" aria-label="WAN Router Cloud identity">
        <div className="auth-brand"><span>W</span><strong>WAN ROUTER</strong></div>
        <div className="auth-context-copy">
          <p>Cloud gateway</p>
          <h1>One WAN identity.<br />A controlled route to AI.</h1>
          <div className="auth-boundaries">
            <span><i />Firebase session</span>
            <span><i />No browser API key</span>
            <span><i />Explicit cloud runtime</span>
          </div>
        </div>
        <small>LOCAL credentials stay on your computer.</small>
      </section>

      <section className="auth-form-panel">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => signInEmail(email.trim(), password));
          }}
        >
          <div className="auth-form-head">
            <Cloud size={20} />
            <div><span>WAN CLOUD</span><h2>Sign in</h2></div>
          </div>
          <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {message && <p className={success ? "auth-message success" : "auth-message"}>{message}</p>}
          <button className="primary-command" type="submit" disabled={busy}>{busy ? "Connecting..." : "Sign in"}</button>
          {!emulator && (
            <button className="secondary-command" type="button" disabled={busy} onClick={() => void run(signInGoogle)}>
              Continue with Google
            </button>
          )}
          <div className="auth-inline-actions">
            <button type="button" disabled={busy} onClick={() => void run(() => createAccount(email.trim(), password))}>Create account</button>
            <button type="button" disabled={busy} onClick={() => void reset()}>Reset password</button>
          </div>
        </form>
      </section>
    </main>
  );
}

function ChatView({ models }: { models: CloudModel[] }) {
  const [model, setModel] = useState(models[0]?.id || "");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<ChatStreamHandle | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!models.some((entry) => entry.id === model)) setModel(models[0]?.id || "");
  }, [model, models]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages]);

  useEffect(() => () => streamRef.current?.abort(), []);

  function patch(id: string, update: (message: ChatMessage) => ChatMessage) {
    setMessages((current) => current.map((message) => message.id === id ? update(message) : message));
  }

  function send() {
    const content = input.trim();
    if (!content || !model || busy) return;
    const requestId = `req_${crypto.randomUUID()}`;
    const assistantId = crypto.randomUUID();
    const history = [
      ...messages.filter((message) => !message.error).map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content },
    ];
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content },
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    setInput("");
    setBusy(true);

    const handle = chatTransport().startChat({ reqId: requestId, model, messages: history }, (event: ChatStreamEvent) => {
      if (event.type === "delta") {
        patch(assistantId, (message) => ({ ...message, content: message.content + event.text }));
      } else if (event.type === "usage") {
        patch(assistantId, (message) => ({ ...message, usage: event.usage }));
      } else if (event.type === "error") {
        patch(assistantId, (message) => ({ ...message, streaming: false, error: event.error }));
        streamRef.current = null;
        setBusy(false);
      } else if (event.type === "done" || event.type === "aborted") {
        patch(assistantId, (message) => ({
          ...message,
          content: event.type === "aborted" && !message.content ? "Generation stopped." : message.content,
          streaming: false,
        }));
        streamRef.current = null;
        setBusy(false);
      }
    });
    streamRef.current = handle;
  }

  return (
    <section className="cloud-chat" aria-label="Cloud chat">
      <header className="view-header">
        <div><span>DATA PLANE</span><h1>Chat</h1></div>
        <label className="model-select-label">Model
          <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || !models.length}>
            {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}
          </select>
        </label>
      </header>

      <div className="cloud-thread" ref={threadRef}>
        {!messages.length && (
          <div className="cloud-empty">
            <Bot size={30} />
            <h2>Start a cloud generation</h2>
            <p>Your prompt passes through WAN Router Cloud and the selected provider route.</p>
          </div>
        )}
        {messages.map((message) => (
          <article className={`cloud-message ${message.role}`} key={message.id}>
            <div className="message-identity">{message.role === "user" ? <UserRound size={15} /> : <Bot size={15} />}</div>
            <div className="message-body">
              {message.role === "assistant" ? <WebMarkdown content={message.content} /> : <p>{message.content}</p>}
              {message.streaming && <span className="stream-cursor" />}
              {message.error && <p className="message-error">{message.error}</p>}
              {message.usage && <small>{message.usage.prompt_tokens} in · {message.usage.completion_tokens} out</small>}
            </div>
          </article>
        ))}
      </div>

      <div className="cloud-composer">
        <textarea
          value={input}
          rows={2}
          placeholder={model ? "Message WAN Router Cloud" : "No cloud model available"}
          disabled={!model}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button type="button" className="stop-command" onClick={() => streamRef.current?.abort()} title="Stop generation" aria-label="Stop generation"><Square size={16} /></button>
        ) : (
          <button type="button" className="send-command" onClick={send} disabled={!input.trim() || !model} title="Send" aria-label="Send"><ArrowUp size={18} /></button>
        )}
      </div>
    </section>
  );
}

function ModelsView({ models, loading, error, onRefresh }: { models: CloudModel[]; loading: boolean; error: string; onRefresh(): void }) {
  return (
    <section className="models-view" aria-label="Cloud models">
      <header className="view-header">
        <div><span>CATALOG</span><h1>Models</h1></div>
        <button type="button" className="icon-command" onClick={onRefresh} disabled={loading} title="Refresh models" aria-label="Refresh models">
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
        </button>
      </header>
      {error && <p className="view-error">{error}</p>}
      <div className="model-table" role="table" aria-label="WAN Router Cloud models">
        <div className="model-row model-head" role="row"><span>ID</span><span>Owner</span><span>Status</span></div>
        {models.map((model) => (
          <div className="model-row" role="row" key={model.id}>
            <strong>{model.id}</strong>
            <span>{model.owned_by}</span>
            <span className="model-status"><i />Available</span>
          </div>
        ))}
        {!loading && !models.length && !error && <div className="model-empty">No cloud models are available.</div>}
      </div>
    </section>
  );
}

const numberFormatter = new Intl.NumberFormat();

function numberLabel(value: number): string {
  return numberFormatter.format(value);
}

function optionalNumberLabel(value: number | null): string {
  return value === null ? "—" : numberLabel(value);
}

function usageDateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function generationModelLabel(generation: CloudGeneration): { primary: string; secondary: string | null } {
  const primary = generation.resolvedModel || generation.requestedModel;
  return {
    primary,
    secondary: generation.resolvedModel && generation.resolvedModel !== generation.requestedModel
      ? `Requested ${generation.requestedModel}`
      : null,
  };
}

function UsageView() {
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [generations, setGenerations] = useState<CloudGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      const [nextUsage, nextGenerations] = await Promise.all([
        getCloudUsage(signal),
        listRecentCloudGenerations(signal),
      ]);
      setUsage(nextUsage);
      setGenerations(nextGenerations);
    } catch (loadError) {
      if (!signal?.aborted) setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);

  const metrics = usage ? [
    ["Total tokens", usage.totals.totalTokens],
    ["Prompt tokens", usage.totals.promptTokens],
    ["Completion tokens", usage.totals.completionTokens],
    ["Generations", usage.generations.total],
    ["Succeeded", usage.generations.succeeded],
    ["Failed", usage.generations.failed],
    ["Cancelled", usage.generations.cancelled],
    ["Pending", usage.generations.pending],
    ["Estimated", usage.estimatedGenerations],
  ] as const : [];

  return (
    <section className="usage-view" aria-label="Cloud usage">
      <header className="view-header">
        <div><span>OBSERVABILITY</span><h1>Usage</h1></div>
        <button type="button" className="icon-command" onClick={() => void refresh()} disabled={loading} title="Refresh usage" aria-label="Refresh usage">
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
        </button>
      </header>

      <div className="usage-content">
        {error && <p className="view-error usage-error">{error}</p>}

        {usage && (
          <dl className="usage-metrics">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{numberLabel(value)}</dd>
              </div>
            ))}
          </dl>
        )}

        <div className="usage-section-head">
          <div><span>RECENT</span><h2>Generations</h2></div>
          {usage && <small>{numberLabel(generations.length)} shown</small>}
        </div>

        <div className="generation-table" role="table" aria-label="Recent cloud generations">
          <div className="generation-row generation-head" role="row">
            <span>Started</span><span>Status</span><span>Model</span><span>Tokens</span><span>Route</span>
          </div>
          {generations.map((generation) => {
            const model = generationModelLabel(generation);
            return (
              <div className="generation-row" role="row" key={generation.id}>
                <div data-label="Started"><strong>{usageDateLabel(generation.requestStartedAt)}</strong><small>{generation.requestId}</small></div>
                <div data-label="Status"><span className={`generation-status ${generation.status}`}>{generation.status}</span></div>
                <div data-label="Model" className="generation-model"><strong>{model.primary}</strong>{model.secondary && <small>{model.secondary}</small>}</div>
                <div data-label="Tokens" className="generation-tokens">
                  <strong>{optionalNumberLabel(generation.totalTokens)}</strong>
                  <small>{optionalNumberLabel(generation.promptTokens)} in / {optionalNumberLabel(generation.completionTokens)} out</small>
                  {generation.usageEstimated === true && <span>Estimated</span>}
                </div>
                <div data-label="Route" className="generation-route"><strong>{generation.providerEndpointId || "Unresolved"}</strong><small>{generation.apiKeyId ? "WAN API key" : "Firebase session"}</small></div>
              </div>
            );
          })}
          {loading && !usage && <div className="usage-state"><RefreshCw size={22} className="spinning" /><strong>Loading usage</strong></div>}
          {!loading && usage && !generations.length && !error && <div className="usage-state"><Activity size={22} /><strong>No generations recorded</strong></div>}
        </div>
      </div>
    </section>
  );
}

function CloudConsole({ user }: { user: User }) {
  const [view, setView] = useState<ViewId>("chat");
  const [models, setModels] = useState<CloudModel[]>([]);
  const [providerCredentialProviders, setProviderCredentialProviders] = useState<CloudProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);

  async function refreshModels() {
    setLoading(true);
    setError("");
    try {
      setModels(await listCloudModels());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refreshModels();
    void getCloudRuntimeCapabilities(controller.signal)
      .then((capabilities) => setProviderCredentialProviders(capabilities.providerCredentialProviders))
      .catch(() => setProviderCredentialProviders([]));
    return () => controller.abort();
  }, []);

  function navigate(next: ViewId) {
    setView(next);
    setMobileNav(false);
  }

  return (
    <div className="cloud-console">
      <aside className={mobileNav ? "cloud-sidebar open" : "cloud-sidebar"}>
        <div className="console-brand"><span>W</span><div><strong>WAN ROUTER</strong><small>CLOUD CONSOLE</small></div></div>
        <button className="mobile-close" type="button" onClick={() => setMobileNav(false)} title="Close navigation" aria-label="Close navigation"><X size={18} /></button>
        <nav>
          <button className={view === "chat" ? "active" : ""} onClick={() => navigate("chat")}><Send size={17} /><span>Chat</span></button>
          <button className={view === "models" ? "active" : ""} onClick={() => navigate("models")}><Boxes size={17} /><span>Models</span></button>
          <button className={view === "providers" ? "active" : ""} onClick={() => navigate("providers")}><Plug size={17} /><span>Providers</span></button>
          <button className={view === "usage" ? "active" : ""} onClick={() => navigate("usage")}><Activity size={17} /><span>Usage</span></button>
          <button className={view === "keys" ? "active" : ""} onClick={() => navigate("keys")}><KeyRound size={17} /><span>API Keys</span></button>
        </nav>
        <div className="runtime-source"><Cloud size={15} /><div><strong>WAN CLOUD</strong><span><i />Connected</span></div></div>
        <div className="account-block">
          <span className="account-avatar">{(user.displayName || user.email || "W").slice(0, 1).toUpperCase()}</span>
          <div><strong>{user.displayName || user.email?.split("@")[0] || "WAN User"}</strong><span>{user.email}</span></div>
          <button type="button" onClick={() => void signOutWan()} title="Sign out" aria-label="Sign out"><LogOut size={15} /></button>
        </div>
      </aside>
      {mobileNav && <button className="nav-scrim" type="button" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <main className="cloud-main">
        <div className="mobile-bar">
          <button type="button" onClick={() => setMobileNav(true)} title="Open navigation" aria-label="Open navigation"><Menu size={19} /></button>
          <strong>WAN ROUTER</strong>
          <span><i />CLOUD</span>
        </div>
        {view === "chat" && (
          error && !models.length
            ? <div className="fatal-view"><Cloud size={28} /><h1>Cloud catalog unavailable</h1><p>{error}</p><button onClick={() => void refreshModels()}><RefreshCw size={15} />Retry</button></div>
            : <ChatView models={models} />
        )}
        {view === "models" && <ModelsView models={models} loading={loading} error={error} onRefresh={() => void refreshModels()} />}
        {view === "providers" && <ProvidersView enabledProviders={providerCredentialProviders} />}
        {view === "usage" && <UsageView />}
        {view === "keys" && <ApiKeysView />}
      </main>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let unsubscribe = () => {};
    void firebaseServices()
      .then(({ auth }) => {
        unsubscribe = onAuthStateChanged(auth, (nextUser) => {
          setUser(nextUser);
          setLoading(false);
        });
      })
      .catch((serviceError) => {
        setError(serviceError instanceof Error ? serviceError.message : String(serviceError));
        setLoading(false);
      });
    return () => unsubscribe();
  }, []);

  if (loading) return <div className="boot-view"><span>W</span><p>Connecting WAN identity...</p></div>;
  if (error) return <div className="boot-view error"><Cloud size={28} /><h1>Cloud runtime unavailable</h1><p>{error}</p></div>;
  return user ? <CloudConsole user={user} /> : <AuthGate />;
}