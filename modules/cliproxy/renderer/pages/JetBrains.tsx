import { useEffect, useState } from "react";
import { AlertTriangle, Braces, CheckCircle2, Clipboard, Code2, KeyRound, Layers3, Link2, PlugZap, RefreshCw, ServerOff } from "lucide-react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { PageHeader, CardHead, CommandSummary, EmptyState } from "../components/shared";
import { toast } from "../components/ui";
import type { WanJetBrainsState, WanJetBrainsSyncResult } from "../wan";

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

  const targetCount = jb?.targets.length ?? 0;
  const syncedCount = jb?.targets.filter((target) => target.hasEntry).length ?? 0;
  const runningCount = jb?.running.length ?? 0;

  return (
    <div className="page ide-page jetbrains-page">
      <PageHeader
        eyebrow="Integration"
        title="JetBrains · ProxyAI"
        subtitle="Deploy enabled models into IntelliJ, Android Studio, and other ProxyAI-enabled IDEs."
        actions={
          <button className="btn" onClick={copyKey}>
            <Clipboard size={15} />
            Copy API Key
          </button>
        }
      />

      <CommandSummary
        tone="amber"
        icon={<PlugZap size={21} />}
        eyebrow="IDE deployment"
        title={targetCount ? `${syncedCount} of ${targetCount} IDE targets configured` : "No JetBrains target detected"}
        description="ProxyAI receives one managed Custom OpenAI service per enabled model, including endpoint and credential wiring."
        status={
          <span className={`command-status-pill ${targetCount > 0 && runningCount === 0 ? "success" : "neutral"}`}>
            {runningCount > 0 ? <AlertTriangle size={13} /> : targetCount > 0 ? <CheckCircle2 size={13} /> : <ServerOff size={13} />}
            {runningCount > 0 ? `${runningCount} IDE running` : targetCount > 0 ? "Ready to sync" : "Awaiting IDE"}
          </span>
        }
        metrics={[
          { label: "detected", value: targetCount },
          { label: "synced", value: syncedCount, tone: syncedCount ? "success" : "default" },
          { label: "running", value: runningCount, tone: runningCount ? "warn" : "default" },
          { label: "models ready", value: enabled.length },
        ]}
      />

      <div className="card jetbrains-deploy-card">
        <CardHead
          icon={<PlugZap size={18} />}
          title="Auto-inject to ProxyAI (experimental)"
          subtitle="Writes ProxyAI's config directly — one provider per enabled model, no manual paste"
          right={
            <button className="btn" onClick={inject} disabled={syncing}>
              <RefreshCw className={syncing ? "ide-sync-spin" : ""} size={15} />
              {syncing ? "Syncing…" : "Sync to JetBrains"}
            </button>
          }
        />
        <div className="ide-deploy-description">
          Creates a Custom OpenAI service per enabled model with URL and model pre-filled. On macOS the required API-key
          credential is written straight into the login Keychain, so <b>no manual paste</b> is needed. JetBrains only
          reads plugin settings and credentials at startup, so <b>fully quit the IDE first</b> (⌘Q), click Sync, then
          reopen — otherwise the change is ignored or overwritten.
        </div>

        {jb && jb.running.length > 0 && (
          <div className="ide-running-warning">
            <AlertTriangle size={17} />
            <span>JetBrains IDE running ({jb.running.join(", ")}). Fully quit it, sync again, then reopen so settings are not overwritten.</span>
          </div>
        )}

        {jb && jb.targets.length === 0 && (
          <EmptyState icon={<PlugZap size={18} />}>No JetBrains IDE detected on this machine.</EmptyState>
        )}

        {(jb?.targets ?? []).map((t) => {
          const r = result?.targets.find((x) => x.product === t.product);
          const status = r ? r.status : t.hasEntry ? "synced" : "not synced";
          const tone = r?.status === "error" ? "error" : status === "written" || status === "synced" ? "ok" : "neutral";
          return (
            <div key={t.product} className={`ide-target-row ${tone === "ok" ? "synced" : tone === "error" ? "error" : "pending"}`}>
              <span className="ide-target-icon"><Code2 size={17} /></span>
              <div>
                <strong>{t.product}</strong>
                <span>{r?.error ?? t.file}</span>
              </div>
              <span className={`badge ${tone}`}>{status}</span>
            </div>
          );
        })}

        {result && result.targets.length > 0 && (
          <div className="ide-result-note">
            <KeyRound size={16} />
            <span>
            {result.keychainSupported
              ? `Keychain: ${result.keychainWritten} credential(s) written — no manual paste needed. Fully quit (⌘Q) and reopen the IDE to apply.`
              : "This OS can't auto-fill the credential — paste the API key (button above) once per model in ProxyAI settings. It persists across future syncs."}
            </span>
          </div>
        )}
      </div>

      <div className="card accent ide-manual-card">
        <CardHead
          icon={<Braces size={18} />}
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
        <div className="card ide-asset-card">
          <CardHead
            icon={<Link2 size={18} />}
            title="URL"
            subtitle="Chat Completions endpoint"
            right={
              <button className="btn secondary" onClick={() => copy(proxyUrl, "URL")}>
                <Clipboard size={14} />
                Copy
              </button>
            }
          />
          <div className="mono-chip">{proxyUrl}</div>
        </div>

        <div className="card ide-asset-card">
          <CardHead
            icon={<KeyRound size={18} />}
            title="Headers"
            subtitle="Authorization uses your pasted API key"
            right={
              <button className="btn secondary" onClick={() => copy(HEADERS, "Headers")}>
                <Clipboard size={14} />
                Copy
              </button>
            }
          />
          <div className="mono-chip" style={{ whiteSpace: "pre-wrap" }}>{HEADERS}</div>
        </div>
      </div>

      <div className="card ide-models-card">
        <CardHead
          icon={<Layers3 size={18} />}
          title="Enabled models"
          subtitle="Set one as the provider's model (Body tab), or make one provider per model"
        />
        {enabled.length === 0 && (
          <EmptyState icon={<Layers3 size={18} />}>No models enabled yet — enable some on the Models page.</EmptyState>
        )}
        {enabled.map((m) => (
          <div key={m.id} className="ide-model-row">
            <span className="ide-target-icon"><Layers3 size={16} /></span>
            <div>
              <strong>{m.label}</strong>
              <span>{m.id}</span>
            </div>
            <div className="btn-row">
              <button className="btn secondary" onClick={() => copy(m.id, "Model id")}>
                <Clipboard size={14} />
                Copy id
              </button>
              <button className="btn secondary" onClick={() => copyBody(m.id)}>
                <Braces size={14} />
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
