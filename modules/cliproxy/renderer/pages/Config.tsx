import { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, FileCode2, GitBranch, RotateCcw, Save, ServerCog, ShieldAlert } from "lucide-react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { CommandSummary, PageHeader } from "../components/shared";

const STRATEGY_OPTIONS = [
  { id: "round-robin" as const, label: "Round-robin", description: "Cycle through every matching credential evenly." },
  { id: "fill-first" as const, label: "Fill-first", description: "Exhaust one credential's quota before moving to the next." },
];

export function Config() {
  const { data, isLoading } = usePolling(api.getConfigYaml, 60000);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const { data: routing, mutate: mutateRouting } = usePolling(api.getRoutingStrategy, 60000);
  const [routingSaving, setRoutingSaving] = useState(false);

  useEffect(() => {
    if (data !== undefined) setDraft(data);
  }, [data]);

  async function save() {
    setSaving(true);
    try {
      await api.putConfigYaml(draft ?? "");
      mutateRouting(undefined, true);
    } finally {
      setSaving(false);
    }
  }

  async function setStrategy(strategy: "round-robin" | "fill-first") {
    if (routing?.strategy === strategy) return;
    setRoutingSaving(true);
    try {
      await api.setRoutingStrategy(strategy);
      mutateRouting(undefined, true);
      const fresh = await api.getConfigYaml();
      setDraft(fresh);
    } finally {
      setRoutingSaving(false);
    }
  }

  const dirty = draft !== null && data !== undefined && draft !== data;

  return (
    <div className="page config-page">
      <PageHeader
        eyebrow="Advanced"
        title="Config"
        subtitle="Manage request routing and the validated CLIProxyAPI configuration source."
      />

      <CommandSummary
        tone="amber"
        icon={<ServerCog size={21} />}
        eyebrow="Runtime configuration"
        title={dirty ? "Unsaved configuration changes" : "Configuration synchronized"}
        description="The YAML editor replaces the full config file only after server-side validation; sensitive values remain hidden until explicitly revealed."
        status={
          <span className={`command-status-pill ${dirty ? "neutral" : "success"}`}>
            {dirty ? <ShieldAlert size={13} /> : <CheckCircle2 size={13} />}
            {dirty ? "Review before save" : "No pending changes"}
          </span>
        }
        metrics={[
          { label: "routing", value: routing?.strategy === "fill-first" ? "Fill" : "Round" },
          { label: "editor", value: revealed ? "Open" : "Locked", tone: revealed ? "warn" : "default" },
          { label: "changes", value: dirty ? "Pending" : "Clean", tone: dirty ? "warn" : "success" },
        ]}
      />

      <section className="card config-routing-card">
        <div className="config-card-head">
          <span className="config-card-icon"><GitBranch size={18} /></span>
          <div>
            <strong>Routing strategy</strong>
            <span>How requests are distributed among matching credentials.</span>
          </div>
        </div>
        <div className="config-strategies">
          {STRATEGY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              disabled={routingSaving}
              onClick={() => setStrategy(opt.id)}
              className={`strategy-option ${routing?.strategy === opt.id ? "selected" : ""}`}
            >
              <span className="config-strategy-check">{routing?.strategy === opt.id ? <CheckCircle2 size={15} /> : null}</span>
              <div><strong>{opt.label}</strong><span>{opt.description}</span></div>
            </button>
          ))}
        </div>
      </section>

      <section className="card config-yaml-card">
        <div className="config-card-head">
          <span className="config-card-icon"><FileCode2 size={18} /></span>
          <div>
            <strong>config.yaml</strong>
            <span>Full source file · plaintext API keys are hidden by default.</span>
          </div>
          <span className={`config-dirty-state ${dirty ? "dirty" : ""}`}>{dirty ? "Modified" : "Saved"}</span>
        </div>
        {isLoading ? (
          <p className="card-desc">Loading...</p>
        ) : (
          <div className="config-editor-wrap">
            <textarea className={`config-editor ${revealed ? "" : "blurred"}`} value={draft ?? ""} onChange={(e) => setDraft(e.target.value)} spellCheck={false} readOnly={!revealed} tabIndex={revealed ? undefined : -1} />
            {!revealed && (
              <div className="reveal-overlay">
                <button className="btn secondary" onClick={() => setRevealed(true)}>
                  <Eye size={15} />
                  Reveal & edit
                </button>
              </div>
            )}
          </div>
        )}
        <div className="btn-row">
          <button className="btn" disabled={saving || !revealed || draft === data} onClick={save}>
            <Save size={15} />
            {saving ? "Saving..." : "Save"}
          </button>
          {revealed && (
            <button className="btn secondary" disabled={saving || draft === data} onClick={() => data !== undefined && setDraft(data)}>
              <RotateCcw size={15} />
              Discard changes
            </button>
          )}
          {revealed && (
            <button className="btn secondary" onClick={() => setRevealed(false)}>
              <EyeOff size={15} />
              Hide
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
