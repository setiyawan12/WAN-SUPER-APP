import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  createCloudApiKey,
  listCloudApiKeys,
  revokeCloudApiKey,
  type CloudApiKey,
  type CloudApiKeyScope,
  type CreatedCloudApiKey,
} from "./api";

const SCOPE_OPTIONS: { value: CloudApiKeyScope; label: string; description: string }[] = [
  { value: "models:read", label: "Models", description: "List the cloud model catalog." },
  { value: "chat:write", label: "Chat", description: "Create chat completions and streams." },
  { value: "usage:read", label: "Usage", description: "Read usage summaries and recent generations." },
];

function dateLabel(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function SecretDialog({ created, onClose }: { created: CreatedCloudApiKey; onClose(): void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(created.key);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  return (
    <div className="key-dialog-backdrop" role="presentation">
      <section className="key-dialog" role="dialog" aria-modal="true" aria-labelledby="key-secret-title">
        <header>
          <div><span>ONE-TIME SECRET</span><h2 id="key-secret-title">API key created</h2></div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"><X size={17} /></button>
        </header>
        <p>Copy this key now. WAN Router stores only its digest and cannot show the secret again.</p>
        <div className="key-secret-value">
          <code>{created.key}</code>
          <button type="button" onClick={() => void copy()} title="Copy API key" aria-label="Copy API key">
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
        <div className="key-dialog-meta"><span>{created.name}</span><span>{created.scopes.join(" · ")}</span></div>
        <button className="primary-command" type="button" onClick={onClose}>I saved the key</button>
      </section>
    </div>
  );
}

export function ApiKeysView() {
  const [keys, setKeys] = useState<CloudApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<CloudApiKeyScope[]>(["models:read", "chat:write"]);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedCloudApiKey | null>(null);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setKeys(await listCloudApiKeys());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  function toggleScope(scope: CloudApiKeyScope) {
    setScopes((current) => current.includes(scope)
      ? current.filter((candidate) => candidate !== scope)
      : [...current, scope]);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !scopes.length) return;
    setCreating(true);
    setError("");
    try {
      const next = await createCloudApiKey({ name: name.trim(), scopes });
      setCreated(next);
      setName("");
      setScopes(["models:read", "chat:write"]);
      setShowCreate(false);
      await refresh();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(key: CloudApiKey) {
    if (!window.confirm(`Revoke “${key.name}”? Clients using this key will fail immediately.`)) return;
    setRevoking(key.id);
    setError("");
    try {
      await revokeCloudApiKey(key.id);
      await refresh();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : String(revokeError));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="keys-view" aria-label="WAN API keys">
      <header className="view-header">
        <div><span>CONTROL PLANE</span><h1>API Keys</h1></div>
        <div className="key-header-actions">
          <button type="button" className="icon-command" onClick={() => void refresh()} disabled={loading} title="Refresh API keys" aria-label="Refresh API keys">
            <RefreshCw size={16} className={loading ? "spinning" : ""} />
          </button>
          <button type="button" className="key-create-command" onClick={() => setShowCreate((current) => !current)}>
            <Plus size={16} /><span>New key</span>
          </button>
        </div>
      </header>

      <div className="keys-content">
        <div className="keys-intro">
          <KeyRound size={20} />
          <div><strong>External client credentials</strong><p>Use WAN API keys in SDKs and servers. The browser console continues to use your Firebase session.</p></div>
        </div>

        {showCreate && (
          <form className="key-create-form" onSubmit={(event) => void create(event)}>
            <label>Name<input value={name} maxLength={80} autoFocus placeholder="Production CLI" onChange={(event) => setName(event.target.value)} /></label>
            <fieldset>
              <legend>Scopes</legend>
              <div className="scope-options">
                {SCOPE_OPTIONS.map((option) => (
                  <label key={option.value}>
                    <input type="checkbox" checked={scopes.includes(option.value)} onChange={() => toggleScope(option.value)} />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="key-form-actions">
              <button type="button" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="primary-command" type="submit" disabled={creating || !name.trim() || !scopes.length}>{creating ? "Creating..." : "Create key"}</button>
            </div>
          </form>
        )}

        {error && <p className="view-error key-error">{error}</p>}

        <div className="keys-table" role="table" aria-label="WAN API keys">
          <div className="keys-row keys-head" role="row"><span>Name</span><span>Credential</span><span>Scopes</span><span>Last used</span><span /></div>
          {keys.map((key) => (
            <div className="keys-row" role="row" key={key.id}>
              <div>
                <strong>{key.name}</strong>
                <small>{dateLabel(key.createdAt)}<span className={`key-status ${key.status}`}>{key.status}</span></small>
              </div>
              <code>{key.prefix}</code>
              <div className="key-scope-list">{key.scopes.map((scope) => <span key={scope}>{scope}</span>)}</div>
              <span>{dateLabel(key.lastUsedAt)}</span>
              <button
                type="button"
                className="key-revoke"
                disabled={key.status === "revoked" || revoking === key.id}
                onClick={() => void revoke(key)}
                title={key.status === "revoked" ? "API key revoked" : "Revoke API key"}
                aria-label={key.status === "revoked" ? `${key.name} revoked` : `Revoke ${key.name}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {!loading && !keys.length && <div className="keys-empty"><KeyRound size={22} /><strong>No WAN API keys</strong><span>Create one for an external SDK, server, or CLI.</span></div>}
        </div>
      </div>

      {created && <SecretDialog created={created} onClose={() => setCreated(null)} />}
    </section>
  );
}