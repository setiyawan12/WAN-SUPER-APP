import { useEffect, useState } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { PageHeader, CardHead, EmptyState } from "../components/shared";
import { toast } from "../components/ui";
import type { WanJetBrainsState, WanJetBrainsSyncResult } from "../wan";

const jv = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const IconPlug = <svg {...jv}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v5" /></svg>;
const IconLink = <svg {...jv}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></svg>;
const IconKey = <svg {...jv}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.5 12.5 20 3" /><path d="M15 3h5v5" /></svg>;
const IconLayers = <svg {...jv}><path d="M12 2 3 7l9 5 9-5-9-5Z" /><path d="M3 12l9 5 9-5" /><path d="M3 17l9 5 9-5" /></svg>;

const HEADERS = "Authorization: Bearer $CUSTOM_SERVICE_API_KEY\nContent-Type: application/json";

export function JetBrains() {
  const [proxyUrl, setProxyUrl] = useState("http://127.0.0.1:4317/api/proxy/v1/chat/completions");
  const { data: models } = usePolling(api.getModels, 20000);
  const [jb, setJb] = useState<WanJetBrainsState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<WanJetBrainsSyncResult | null>(null);

  const refreshJb = () => void window.wan.jetbrainsState().then(setJb);

  useEffect(() => {
    void window.wan.backendInfo().then((i) => setProxyUrl(i.proxyUrl));
    refreshJb();
  }, []);

  const enabled = (models?.models ?? []).filter((m) => m.enabled);

  async function inject() {
    setSyncing(true);
    try {
      const r = await window.wan.jetbrainsSync();
      setResult(r);
      refreshJb();
      if (!r.ok) toast.error(r.error ?? "Sync failed");
      else if (!r.targets.length) toast.error("No JetBrains IDE detected");
      else if (r.running.length) toast.success("Written — now close & reopen your IDE");
      else toast.success(`Injected ${r.modelCount} model(s) into ${r.targets.length} target(s)`);
    } finally {
      setSyncing(false);
    }
  }

  function copy(text: string, label: string) {
    void window.wan.copyText(text);
    toast.success(`${label} copied`);
  }

  function copyBody(id: string) {
    copy(JSON.stringify({ stream: true, model: id, messages: "$OPENAI_MESSAGES" }, null, 2), "Body JSON");
  }

  async function copyKey() {
    const r = await window.wan.copyApiKey();
    if (r.ok) toast.success("API key copied");
    else toast.error(r.error ?? "No API key yet");
  }

  return (
    <div className="page">
      <PageHeader
        eyebrow="Integration"
        title="JetBrains · ProxyAI"
        subtitle="Use your models in IntelliJ / Android Studio through the ProxyAI plugin's Custom OpenAI provider."
        actions={
          <button className="btn" onClick={copyKey}>
            Copy API Key
          </button>
        }
      />

      <div className="card">
        <CardHead
          icon={IconPlug}
          title="Auto-inject to ProxyAI (experimental)"
          subtitle="Writes ProxyAI's config directly — one provider per enabled model, no manual paste"
          right={
            <button className="btn" onClick={inject} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync to JetBrains"}
            </button>
          }
        />
        <div className="card-desc">
          Creates a Custom OpenAI service per enabled model with URL and model pre-filled. On macOS the required API-key
          credential is written straight into the login Keychain, so <b>no manual paste</b> is needed. JetBrains only
          reads plugin settings and credentials at startup, so <b>fully quit the IDE first</b> (⌘Q), click Sync, then
          reopen — otherwise the change is ignored or overwritten.
        </div>

        {jb && jb.running.length > 0 && (
          <div className="empty-hint" style={{ color: "var(--wan-red)" }}>
            ⚠ JetBrains IDE running ({jb.running.join(", ")}). Close it, Sync again, then reopen — otherwise the change
            is overwritten when the IDE exits.
          </div>
        )}

        {jb && jb.targets.length === 0 && (
          <EmptyState icon={IconPlug}>No JetBrains IDE detected on this machine.</EmptyState>
        )}

        {(jb?.targets ?? []).map((t) => {
          const r = result?.targets.find((x) => x.product === t.product);
          const status = r ? r.status : t.hasEntry ? "synced" : "not synced";
          const tone = r?.status === "error" ? "error" : status === "written" || status === "synced" ? "ok" : "neutral";
          return (
            <div key={t.product} className="model-row">
              <div style={{ minWidth: 0 }}>
                <div className="model-row-name">{t.product}</div>
                <div className="model-row-id">{r?.error ?? t.file}</div>
              </div>
              <div className="btn-row">
                <span className={`badge ${tone}`}>{status}</span>
              </div>
            </div>
          );
        })}

        {result && result.targets.length > 0 && (
          <div className="empty-hint">
            {result.keychainSupported
              ? `Keychain: ${result.keychainWritten} credential(s) written — no manual paste needed. Fully quit (⌘Q) and reopen the IDE to apply.`
              : "This OS can't auto-fill the credential — paste the API key (button above) once per model in ProxyAI settings. It persists across future syncs."}
          </div>
        )}
      </div>

      <div className="card accent">
        <CardHead
          icon={IconPlug}
          title="Manual setup (fallback)"
          subtitle="Settings › Tools › ProxyAI › Providers › Custom OpenAI"
        />
        <div className="card-desc">
          Add a Custom OpenAI provider with preset "OpenAI (Chat Completions API)", paste the API key (button above),
          then fill in the URL and pick a model below. Using the sanitizer URL (port 4317) instead of 8317 lets Claude
          models work too — it strips the sampling params Anthropic rejects.
        </div>
      </div>

      <div className="cols c-2">
        <div className="card">
          <CardHead
            icon={IconLink}
            title="URL"
            subtitle="Chat Completions endpoint"
            right={
              <button className="btn secondary" onClick={() => copy(proxyUrl, "URL")}>
                Copy
              </button>
            }
          />
          <div className="mono-chip">{proxyUrl}</div>
        </div>

        <div className="card">
          <CardHead
            icon={IconKey}
            title="Headers"
            subtitle="Authorization uses your pasted API key"
            right={
              <button className="btn secondary" onClick={() => copy(HEADERS, "Headers")}>
                Copy
              </button>
            }
          />
          <div className="mono-chip" style={{ whiteSpace: "pre-wrap" }}>{HEADERS}</div>
        </div>
      </div>

      <div className="card">
        <CardHead
          icon={IconLayers}
          title="Enabled models"
          subtitle="Set one as the provider's model (Body tab), or make one provider per model"
        />
        {enabled.length === 0 && (
          <EmptyState icon={IconLayers}>No models enabled yet — enable some on the Models page.</EmptyState>
        )}
        {enabled.map((m) => (
          <div key={m.id} className="model-row">
            <div style={{ minWidth: 0 }}>
              <div className="model-row-name">{m.label}</div>
              <div className="model-row-id">{m.id}</div>
            </div>
            <div className="btn-row">
              <button className="btn secondary" onClick={() => copy(m.id, "Model id")}>
                Copy id
              </button>
              <button className="btn secondary" onClick={() => copyBody(m.id)}>
                Copy body
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="empty-hint">
        Want this to auto-sync whenever you toggle models here (no manual paste)? That needs ProxyAI's paid "Custom
        Extension" (Enterprise), which supports Remote Settings — ask me to enable the local Remote Settings endpoint if
        you have it.
      </div>
    </div>
  );
}
