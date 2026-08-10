import { useEffect, useState, type FormEvent } from "react";
import { Check, Plus, Plug, RefreshCw, Trash2 } from "lucide-react";
import {
  createCloudProviderCredential,
  deleteCloudProviderCredential,
  listCloudProviderCredentials,
  verifyCloudProviderCredential,
  type CloudProvider,
  type CloudProviderCredential,
} from "./api";

const PROVIDER_OPTIONS: { value: CloudProvider; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "mock", label: "Mock" },
];

const MODEL_FILTER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

function dateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function providerLabel(provider: CloudProvider): string {
  return PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
}

function parseModelFilters(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

export function ProvidersView({ enabledProviders }: { enabledProviders: CloudProvider[] }) {
  const availableOptions = PROVIDER_OPTIONS.filter((option) => enabledProviders.includes(option.value));
  const [credentials, setCredentials] = useState<CloudProviderCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [provider, setProvider] = useState<CloudProvider | "">(availableOptions[0]?.value ?? "");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [modelFilters, setModelFilters] = useState("");
  const [priority, setPriority] = useState("0");
  const [creating, setCreating] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError("");
    try {
      setCredentials(await listCloudProviderCredentials(signal));
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

  useEffect(() => {
    if (!provider || !enabledProviders.includes(provider)) {
      setProvider(availableOptions[0]?.value ?? "");
    }
  }, [availableOptions, enabledProviders, provider]);

  function resetCreate() {
    setProvider(availableOptions[0]?.value ?? "");
    setName("");
    setSecret("");
    setModelFilters("");
    setPriority("0");
  }

  function closeCreate() {
    resetCreate();
    setShowCreate(false);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const filters = parseModelFilters(modelFilters);
    const numericPriority = Number(priority);
    if (!provider || !enabledProviders.includes(provider) || !name.trim() || secret.length < 8) return;
    if (filters.length > 128 || filters.some((filter) => !MODEL_FILTER_PATTERN.test(filter))) {
      setError("Model filters must be valid model IDs, with no more than 128 entries.");
      return;
    }
    if (!Number.isInteger(numericPriority) || numericPriority < -1000 || numericPriority > 1000) {
      setError("Priority must be an integer between -1000 and 1000.");
      return;
    }

    let submittedSecret = secret;
    setSecret("");
    setCreating(true);
    setError("");
    try {
      const created = await createCloudProviderCredential({
        provider,
        name: name.trim(),
        secret: submittedSecret,
        modelFilters: filters,
        priority: numericPriority,
      });
      setCredentials((current) => [created, ...current.filter((credential) => credential.id !== created.id)]);
      resetCreate();
      setShowCreate(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      submittedSecret = "";
      setCreating(false);
    }
  }

  async function verify(credential: CloudProviderCredential) {
    setVerifying(credential.id);
    setError("");
    try {
      const verified = await verifyCloudProviderCredential(credential.id);
      setCredentials((current) => current.map((entry) => entry.id === verified.id ? verified : entry));
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : String(verifyError));
    } finally {
      setVerifying(null);
    }
  }

  async function remove(credential: CloudProviderCredential) {
    if (!window.confirm(`Delete "${credential.name}"? This provider credential cannot be recovered.`)) return;
    setDeleting(credential.id);
    setError("");
    try {
      await deleteCloudProviderCredential(credential.id);
      setCredentials((current) => current.filter((entry) => entry.id !== credential.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="providers-view" aria-label="Cloud provider credentials">
      <header className="view-header">
        <div><span>CONTROL PLANE</span><h1>Providers</h1></div>
        <div className="view-header-actions">
          <button type="button" className="icon-command" onClick={() => void refresh()} disabled={loading} title="Refresh providers" aria-label="Refresh providers">
            <RefreshCw size={16} className={loading ? "spinning" : ""} />
          </button>
          {availableOptions.length > 0 && (
            <button
              type="button"
              className="create-command"
              onClick={() => {
                if (showCreate) closeCreate();
                else setShowCreate(true);
              }}
            >
              <Plus size={16} /><span>New provider</span>
            </button>
          )}
        </div>
      </header>

      <div className="providers-content">
        {showCreate && (
          <form className="provider-create-form" onSubmit={(event) => void create(event)}>
            <div className="provider-form-grid">
              <label>Provider
                <select value={provider} onChange={(event) => setProvider(event.target.value as CloudProvider)}>
                  {availableOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label>Name
                <input value={name} maxLength={80} autoFocus placeholder="Primary OpenAI" onChange={(event) => setName(event.target.value)} />
              </label>
              <label>Secret
                <input type="password" value={secret} minLength={8} maxLength={16_384} autoComplete="off" spellCheck={false} placeholder="Provider API key" onChange={(event) => setSecret(event.target.value)} />
              </label>
              <label>Priority
                <input type="number" value={priority} min={-1000} max={1000} step={1} onChange={(event) => setPriority(event.target.value)} />
              </label>
            </div>
            <label className="provider-model-field">Model filters
              <textarea value={modelFilters} rows={2} placeholder="openai/gpt-4.1, openai/gpt-4.1-mini" onChange={(event) => setModelFilters(event.target.value)} />
            </label>
            <div className="provider-form-actions">
              <button type="button" onClick={closeCreate}>Cancel</button>
              <button className="primary-command" type="submit" disabled={creating || !name.trim() || secret.length < 8}>
                {creating ? "Creating..." : "Create provider"}
              </button>
            </div>
          </form>
        )}

        {error && <p className="view-error provider-error">{error}</p>}

        <div className="providers-table" role="table" aria-label="Cloud provider credentials">
          <div className="provider-row provider-head" role="row"><span>Name</span><span>Credential</span><span>Models</span><span>Priority</span><span>Verification</span><span /></div>
          {credentials.map((credential) => {
            const pending = verifying === credential.id || deleting === credential.id;
            const providerEnabled = enabledProviders.includes(credential.provider);
            const verification = !providerEnabled
              ? "Disabled by runtime"
              : verifying === credential.id
              ? "Verifying..."
              : credential.status === "invalid"
                ? credential.lastVerifiedAt ? `Rejected ${dateLabel(credential.lastVerifiedAt)}` : "Rejected"
                : credential.lastVerifiedAt
                  ? `Verified ${dateLabel(credential.lastVerifiedAt)}`
                  : "Not verified";
            return (
              <div className="provider-row" role="row" key={credential.id}>
                <div className="provider-identity" data-label="Provider">
                  <strong>{credential.name}</strong>
                  <small><span>{providerLabel(credential.provider)}</span><span className={`provider-status ${credential.status}`}>{credential.status}</span></small>
                </div>
                <code data-label="Credential">{credential.maskedValue}</code>
                <div className="provider-filter-list" data-label="Models">
                  {credential.modelFilters.length
                    ? credential.modelFilters.map((filter) => <span key={filter}>{filter}</span>)
                    : <span>All models</span>}
                </div>
                <strong className="provider-priority" data-label="Priority">{credential.priority}</strong>
                <span className={`provider-verification ${credential.status}`} data-label="Verification">{verification}</span>
                <div className="provider-row-actions" data-label="Actions">
                  <button type="button" disabled={pending || !providerEnabled} onClick={() => void verify(credential)} title="Verify credential" aria-label={`Verify ${credential.name}`}>
                    {verifying === credential.id ? <RefreshCw size={15} className="spinning" /> : <Check size={15} />}
                  </button>
                  <button type="button" className="provider-delete" disabled={pending} onClick={() => void remove(credential)} title="Delete credential" aria-label={`Delete ${credential.name}`}>
                    {deleting === credential.id ? <RefreshCw size={15} className="spinning" /> : <Trash2 size={15} />}
                  </button>
                </div>
              </div>
            );
          })}
          {loading && !credentials.length && <div className="providers-state"><RefreshCw size={22} className="spinning" /><strong>Loading providers</strong></div>}
          {!loading && !credentials.length && !error && (
            <div className="providers-state">
              <Plug size={22} />
              <strong>{availableOptions.length ? "No provider credentials" : "Direct providers unavailable"}</strong>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}