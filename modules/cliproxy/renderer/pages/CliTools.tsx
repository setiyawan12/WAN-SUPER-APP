import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Cable,
  CheckCircle2,
  CircleDashed,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Search,
  Server,
  Settings2,
  SquareTerminal,
} from "lucide-react";
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

type ToolView = "all" | "writer" | "guide";

function statusBadge(t: CliTool) {
  if (t.kind === "guide") {
    return <span className="cli-tool-status guide"><BookOpenCheck size={13} />Guided</span>;
  }
  if (!t.installed) {
    return <span className="cli-tool-status neutral"><CircleDashed size={13} />Not detected</span>;
  }
  if (t.configured) {
    return <span className="cli-tool-status success"><CheckCircle2 size={13} />Connected</span>;
  }
  return <span className="cli-tool-status ready"><Settings2 size={13} />Ready</span>;
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
  const [view, setView] = useState<ToolView>("all");
  const [query, setQuery] = useState("");
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
  const filteredTools = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (tools || []).filter((tool) => {
      const matchesView = view === "all" || tool.kind === view;
      const matchesQuery = !needle || `${tool.name} ${tool.description} ${tool.api}`.toLowerCase().includes(needle);
      return matchesView && matchesQuery;
    });
  }, [query, tools, view]);

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
      <div className="page cli-tools-page">
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
      <div className="page cli-tools-page">
        <div className="cli-tools-wrap cli-detail-wrap">
          <button type="button" className="cli-back" onClick={() => setSelectedId(null)}>
            <ArrowLeft size={16} />
            Back to CLI Tools
          </button>

          <div className="cli-detail-card" style={{ "--cli-tool-color": t.color } as CSSProperties}>
            <div className="cli-detail-head">
              <div className="cli-detail-identity">
                <ToolMark t={t} size={52} />
                <div className="cli-detail-copy">
                  <div className="cli-detail-kicker">
                    {t.kind === "writer" ? "Automatic configuration" : "Setup guide"}
                    <span aria-hidden="true">/</span>
                    {t.api === "anthropic" ? "Anthropic API" : "OpenAI API"}
                  </div>
                  <div className="cli-detail-title">{t.name}</div>
                  <div className="cli-detail-description">{t.description}</div>
                </div>
              </div>
              {statusBadge(t)}
            </div>

            <div className="cli-detail-meta">
              <span><Server size={14} />Local proxy</span>
              <span><FileCode2 size={14} />{t.configFile || "Manual setup"}</span>
            </div>

            <div className={`cli-detail-grid ${t.kind === "guide" ? "guide" : ""}`}>
              <section className="cli-detail-pane cli-connection-pane">
                <div className="cli-pane-head">
                  <span className="cli-pane-icon"><Server size={17} /></span>
                  <div>
                    <strong>Connection</strong>
                    <span>Local proxy credentials</span>
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">Endpoint</span>
                  <div className="cli-field-control">
                    <input className="text-input" readOnly value={t.baseUrl} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="cli-icon-btn" onClick={() => copy(t.baseUrl)} title="Copy endpoint" aria-label="Copy endpoint">
                      <Copy size={16} />
                    </button>
                  </div>
                </div>

                <div className="field">
                  <span className="field-label">API Key</span>
                  <div className="cli-field-control">
                    <input className="text-input" readOnly type={showKey ? "text" : "password"} value={apiKey} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="cli-icon-btn" onClick={() => setShowKey((value) => !value)} title={showKey ? "Hide API key" : "Show API key"} aria-label={showKey ? "Hide API key" : "Show API key"}>
                      {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button type="button" className="cli-icon-btn" onClick={() => copy(apiKey)} title="Copy API key" aria-label="Copy API key">
                      <Copy size={16} />
                    </button>
                  </div>
                </div>
              </section>

              <section className="cli-detail-pane cli-config-pane">
                <div className="cli-pane-head">
                  <span className="cli-pane-icon">{t.kind === "writer" ? <Settings2 size={17} /> : <BookOpenCheck size={17} />}</span>
                  <div>
                    <strong>{t.kind === "writer" ? "Model routing" : "Setup"}</strong>
                    <span>{t.kind === "writer" ? "Choose models and write the config" : "Use these values in the tool"}</span>
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
                        {busy === t.id ? <LoaderCircle className="cli-spin" size={16} /> : <Cable size={16} />}
                        {busy === t.id ? "Applying..." : t.configured ? "Update configuration" : "Connect tool"}
                      </button>
                      <button className="btn secondary" disabled={busy === t.id || !t.configured} onClick={() => reset(t)}>
                        <RotateCcw size={15} />
                        Reset
                      </button>
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
                        {t.steps.map((step, index) => (
                          <li key={index}><span>{fill(step, t, primaryModel, apiKey)}</span></li>
                        ))}
                      </ol>
                    )}
                    {t.code && (
                      <div className="cli-code-wrap">
                        <button type="button" className="cli-icon-btn cli-code-copy" onClick={() => copy(fill(t.code!, t, primaryModel, apiKey))} title="Copy snippet" aria-label="Copy snippet">
                          <Copy size={16} />
                        </button>
                        <pre className="code-block">
                          <code>{fill(t.code, t, primaryModel, apiKey)}</code>
                        </pre>
                      </div>
                    )}
                    {t.note && <p className="cli-note">{t.note}</p>}
                  </>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Grid view (all tools) ------------------------------------------------
  const writers = tools.filter((t) => t.kind === "writer");
  const guides = tools.filter((t) => t.kind === "guide");
  const visibleWriters = filteredTools.filter((t) => t.kind === "writer");
  const visibleGuides = filteredTools.filter((t) => t.kind === "guide");
  const connectedCount = writers.filter((t) => t.configured).length;
  const detectedCount = writers.filter((t) => t.installed).length;

  const Card = (t: CliTool, index: number) => (
    <button
      type="button"
      key={t.id}
      className="cli-tool-card"
      style={{ "--cli-tool-color": t.color, "--cli-card-index": index } as CSSProperties}
      onClick={() => {
        setSelectedId(t.id);
        setShowKey(false);
      }}
    >
      <span className="cli-tool-card-top">
        <ToolMark t={t} size={42} />
        {statusBadge(t)}
      </span>
      <span className="cli-tool-body">
        <span className="cli-tool-name">{t.name}</span>
        <span className="cli-tool-desc">{t.description}</span>
      </span>
      <span className="cli-tool-footer">
        <span className="cli-tool-protocol">{t.api === "anthropic" ? "Anthropic" : "OpenAI compatible"}</span>
        <span className="cli-tool-open">
          {t.kind === "writer" ? (t.configured ? "Manage" : "Configure") : "Open guide"}
          <ArrowRight size={15} />
        </span>
      </span>
    </button>
  );

  return (
    <div className="page cli-tools-page">
      <PageHeader
        eyebrow="INTEGRATIONS"
        title="CLI Tools"
        subtitle="Connect coding agents and editors to your local model gateway."
        actions={<span className="cli-live-pill"><span className="cli-live-dot" />Proxy online</span>}
      />

      <div className="cli-tools-wrap">
        <div className="cli-status-strip">
          <div className="cli-status-endpoint">
            <span className="cli-status-icon"><Server size={18} /></span>
            <div>
              <span>Local gateway</span>
              <button type="button" onClick={() => copy(endpoint)} title="Copy endpoint">
                <code>{endpoint}</code>
                <Copy size={14} />
              </button>
            </div>
          </div>
          <div className="cli-status-metrics">
            <span><strong>{connectedCount}</strong> connected</span>
            <span><strong>{detectedCount}</strong> detected</span>
            <span><strong>{tools.length}</strong> integrations</span>
          </div>
        </div>

        <div className="cli-toolbar">
          <label className="cli-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search integrations" aria-label="Search integrations" />
          </label>
          <div className="cli-view-switch" role="tablist" aria-label="CLI Tools category">
            <button type="button" className={view === "all" ? "active" : ""} onClick={() => setView("all")} aria-selected={view === "all"} role="tab">
              All <span>{tools.length}</span>
            </button>
            <button type="button" className={view === "writer" ? "active" : ""} onClick={() => setView("writer")} aria-selected={view === "writer"} role="tab">
              <Settings2 size={14} />Automatic <span>{writers.length}</span>
            </button>
            <button type="button" className={view === "guide" ? "active" : ""} onClick={() => setView("guide")} aria-selected={view === "guide"} role="tab">
              <BookOpenCheck size={14} />Guided <span>{guides.length}</span>
            </button>
          </div>
        </div>

        {visibleWriters.length > 0 && (
          <section className="cli-tool-section">
            <div className="cli-section-head">
              <div><span className="cli-section-icon"><Settings2 size={16} /></span><strong>Automatic setup</strong></div>
              <span>Writes the tool configuration locally</span>
            </div>
            <div className="cli-tool-grid">{visibleWriters.map(Card)}</div>
          </section>
        )}

        {visibleGuides.length > 0 && (
          <section className="cli-tool-section">
            <div className="cli-section-head">
              <div><span className="cli-section-icon"><BookOpenCheck size={16} /></span><strong>Guided setup</strong></div>
              <span>Ready-to-copy settings and snippets</span>
            </div>
            <div className="cli-tool-grid">{visibleGuides.map(Card)}</div>
          </section>
        )}

        {filteredTools.length === 0 && (
          <div className="cli-empty">
            <SquareTerminal size={24} />
            <strong>No integrations found</strong>
            <span>Try another search or category.</span>
          </div>
        )}
      </div>
    </div>
  );
}
