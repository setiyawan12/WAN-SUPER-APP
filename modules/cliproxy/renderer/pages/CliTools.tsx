import { useEffect, useMemo, useState } from "react";
import { api, type CliTool, type ModelEntry } from "../api/client";
import { PageHeader } from "../components/shared";
import { SkeletonRows, toast } from "../components/ui";
import { ModelPicker } from "../components/ModelPicker";

// Wire external coding CLIs/IDEs to this machine's local CLIProxyAPI. Writer
// cards (Claude Code, Codex, OpenCode, …) push a config file server-side and
// report live status; guide cards (Cursor, Amp, …) show copy-paste snippets
// with the endpoint/key/model already substituted. Mirrors 9router's CLI Tools
// page but the endpoint + API key are filled in automatically from the running
// proxy instead of being pasted by the user.

function statusBadge(t: CliTool) {
  if (t.kind === "guide") return null;
  if (!t.installed) return <span className="badge neutral">Not installed</span>;
  if (t.configured) return <span className="badge success">Connected</span>;
  return <span className="badge warn">Not configured</span>;
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success("Copied"),
    () => toast.error("Copy failed")
  );
}

function fill(tpl: string, t: CliTool, model: string, apiKey: string) {
  return tpl
    .replaceAll("{{baseUrl}}", t.baseUrl)
    .replaceAll("{{apiKey}}", apiKey || "<your-key>")
    .replaceAll("{{model}}", model || "<model-id>");
}

// Brand logo for a tool, falling back to a first-letter colored tile if the
// image is missing or fails to load.
function ToolMark({ t, size = 36 }: { t: CliTool; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (t.image && !broken) {
    return (
      <img
        className="cli-tool-mark cli-tool-logo"
        src={t.image}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className="cli-tool-mark"
      style={{ width: size, height: size, background: `linear-gradient(150deg, ${t.color}, ${t.color}bb)`, fontSize: size * 0.42 }}
    >
      {t.name[0]}
    </span>
  );
}

export function CliTools() {
  const [tools, setTools] = useState<CliTool[] | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // per-tool, per-slot chosen model id
  const [picks, setPicks] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  async function load() {
    try {
      const res = await api.getCliTools();
      setTools(res.tools);
      setEndpoint(res.endpoint);
      setApiKey(res.apiKey);
      // Seed pick state from whatever each tool is currently configured with.
      setPicks((prev) => {
        const next = { ...prev };
        for (const t of res.tools) {
          if (t.kind !== "writer" || !t.slots) continue;
          const cur = next[t.id] || {};
          for (const s of t.slots) {
            if (cur[s.key] == null) cur[s.key] = t.current?.[s.key] || "";
          }
          next[t.id] = cur;
        }
        return next;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load CLI tools");
    }
  }

  useEffect(() => {
    load();
    api
      .getModels()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);

  const selected = useMemo(() => tools?.find((t) => t.id === selectedId) || null, [tools, selectedId]);

  function setPick(toolId: string, slot: string, value: string) {
    setPicks((p) => ({ ...p, [toolId]: { ...(p[toolId] || {}), [slot]: value } }));
  }

  async function apply(t: CliTool) {
    const body = picks[t.id] || {};
    const missing = (t.slots || []).some((s) => !body[s.key]);
    if (missing) {
      toast.error("Pick a model for every field first");
      return;
    }
    setBusy(t.id);
    try {
      await api.applyCliTool(t.id, body);
      toast.success(`${t.name} configured`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setBusy(null);
    }
  }

  async function reset(t: CliTool) {
    setBusy(t.id);
    try {
      await api.resetCliTool(t.id);
      toast.info(`${t.name} config removed`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusy(null);
    }
  }

  if (!tools) {
    return (
      <div className="page">
        <PageHeader eyebrow="INTEGRATIONS" title="CLI Tools" subtitle="Configure external coding tools to use this proxy." />
        <SkeletonRows rows={6} />
      </div>
    );
  }

  // --- Detail view (one tool) ----------------------------------------------
  if (selected) {
    const t = selected;
    const primaryModel = picks[t.id]?.[t.slots?.[0]?.key || "model"] || t.current?.model || "";
    return (
      <div className="page">
        <div className="cli-tools-wrap">
          <button className="cli-back" onClick={() => setSelectedId(null)}>
            ← Back to CLI Tools
          </button>

          <div className="cli-detail-card">
            <div className="cli-detail-head">
              <ToolMark t={t} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cli-detail-title">
                  {t.name}
                  {statusBadge(t)}
                </div>
                <div className="page-hint" style={{ margin: 0 }}>{t.description}</div>
              </div>
            </div>

            <div className="field">
              <span className="field-label">Endpoint</span>
              <input className="text-input" readOnly value={t.baseUrl} onFocus={(e) => e.currentTarget.select()} />
            </div>

            <div className="field">
              <span className="field-label">API Key</span>
              <div className="cli-key-row">
                <input className="text-input" readOnly type={showKey ? "text" : "password"} value={apiKey} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn secondary" onClick={() => setShowKey((v) => !v)}>{showKey ? "Hide" : "Show"}</button>
                <button className="btn secondary" onClick={() => copy(apiKey)}>Copy</button>
              </div>
            </div>

            {t.kind === "writer" ? (
              <>
                <div className="cli-slot-grid">
                  {(t.slots || []).map((s) => (
                    <div key={s.key} className="field">
                      <span className="field-label">{s.label}</span>
                      <div className="cli-picker">
                        <ModelPicker models={models} value={picks[t.id]?.[s.key] || ""} onChange={(id) => setPick(t.id, s.key, id)} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="cli-actions">
                  <button className="btn" disabled={busy === t.id} onClick={() => apply(t)}>
                    {busy === t.id ? "Applying…" : "Apply"}
                  </button>
                  <button className="btn secondary" disabled={busy === t.id || !t.configured} onClick={() => reset(t)}>
                    Reset
                  </button>
                  {t.configFile && <span className="page-hint" style={{ margin: 0, marginLeft: "auto" }}>Writes {t.configFile}</span>}
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <span className="field-label">Model</span>
                  <div className="cli-picker">
                    <ModelPicker models={models} value={picks[t.id]?.model || ""} onChange={(id) => setPick(t.id, "model", id)} />
                  </div>
                </div>
                {t.steps && (
                  <ol className="cli-steps">
                    {t.steps.map((step, i) => (
                      <li key={i}>{fill(step, t, primaryModel, apiKey)}</li>
                    ))}
                  </ol>
                )}
                {t.code && (
                  <div className="cli-code-wrap">
                    <button className="btn secondary cli-code-copy" onClick={() => copy(fill(t.code!, t, primaryModel, apiKey))}>Copy</button>
                    <pre className="code-block">
                      <code>{fill(t.code, t, primaryModel, apiKey)}</code>
                    </pre>
                  </div>
                )}
                {t.note && <p className="cli-note">{t.note}</p>}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Grid view (all tools) ------------------------------------------------
  const writers = tools.filter((t) => t.kind === "writer");
  const guides = tools.filter((t) => t.kind === "guide");

  const Card = (t: CliTool) => (
    <button key={t.id} className="cli-tool-card" onClick={() => setSelectedId(t.id)}>
      <ToolMark t={t} />
      <span className="cli-tool-body">
        <span className="cli-tool-name">
          <strong>{t.name}</strong>
          {statusBadge(t)}
        </span>
        <span className="cli-tool-desc">{t.description}</span>
      </span>
      <span className="cli-tool-chevron">›</span>
    </button>
  );

  return (
    <div className="page">
      <PageHeader
        eyebrow="INTEGRATIONS"
        title="CLI Tools"
        subtitle="One-click wire external coding CLIs & IDEs to this machine's local proxy."
        actions={<span className="badge neutral" title="Local proxy endpoint">{endpoint}</span>}
      />

      <div className="cli-tools-wrap">
        <div className="cli-section-label">Auto-configure — one click writes the config</div>
        <div className="cli-tool-grid">{writers.map(Card)}</div>

        <div className="cli-section-label" style={{ marginTop: 26 }}>Manual setup — copy the snippet</div>
        <div className="cli-tool-grid">{guides.map(Card)}</div>
      </div>
    </div>
  );
}
