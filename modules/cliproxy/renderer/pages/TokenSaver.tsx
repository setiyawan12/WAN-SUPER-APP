import { useEffect, useState, type CSSProperties } from "react";
import {
  Activity,
  CheckCircle2,
  Code2,
  Gauge,
  Layers3,
  LoaderCircle,
  MessageSquareText,
  Route,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Zap,
} from "lucide-react";
import { api, type TokenSaverConfig, type TokenSaverLevel, type TokenSaverStats } from "../api/client";
import { PageHeader } from "../components/shared";
import { SkeletonRows, toast } from "../components/ui";

// Token Saver — toggle output-token-reduction techniques applied by the local
// proxy hop (backend token-saver.js). Each technique is an independent on/off
// with a Lite/Full/Ultra intensity, mirroring 9router's Token Saver. Changes
// save immediately (PATCH /token-saver). Only the self-contained techniques are
// here; 9router's Headroom (external Python service) and Pxpipe are not ported.

type TechId = "ponytail" | "caveman";

const LEVELS: TokenSaverLevel[] = ["lite", "full", "ultra"];

const LEVEL_META: Record<TokenSaverLevel, { label: string; tone: string; bars: number }> = {
  lite: { label: "Lite", tone: "Light touch", bars: 1 },
  full: { label: "Full", tone: "Balanced", bars: 2 },
  ultra: { label: "Ultra", tone: "Maximum", bars: 3 },
};

const TECHS: {
  id: TechId;
  name: string;
  tag: string;
  color: string;
  blurb: string;
  levelDesc: Record<TokenSaverLevel, string>;
}[] = [
  {
    id: "caveman",
    name: "Caveman",
    tag: "Terser output",
    color: "#e0894a",
    blurb: "Tells the model to answer in a compressed, telegraphic style — fewer output tokens per reply. Code stays complete and correct.",
    levelDesc: {
      lite: "Trim filler & hedging, keep normal grammar",
      full: "Drop articles & pleasantries, fragments OK",
      ultra: "Telegraphic — minimal words, max compression",
    },
  },
  {
    id: "ponytail",
    name: "Ponytail",
    tag: "Leaner solutions",
    color: "#5aa6e0",
    blurb: "Steers the model toward the smallest solution that works — less generated code, fewer speculative abstractions.",
    levelDesc: {
      lite: "Prefer the simpler of two working options",
      full: "Complexity ladder: stdlib / native first",
      ultra: "YAGNI extremist — build only what's asked",
    },
  },
];

function Switch({ on, busy, label, onToggle }: { on: boolean; busy: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${on ? "Disable" : "Enable"} ${label}`}
      title={`${on ? "Disable" : "Enable"} ${label}`}
      className={`ts-switch${on ? " on" : ""}`}
      disabled={busy}
      onClick={onToggle}
    >
      <span className="ts-knob" />
    </button>
  );
}

export function TokenSaver() {
  const [config, setConfig] = useState<TokenSaverConfig | null>(null);
  const [stats, setStats] = useState<TokenSaverStats | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const res = await api.getTokenSaver();
      setConfig(res.config);
      setStats(res.stats);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Token Saver");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Optimistic: apply locally, PATCH, reconcile with the server's echo.
  async function patch(next: TokenSaverConfig) {
    const prev = config;
    setConfig(next);
    setBusy(true);
    try {
      const res = await api.setTokenSaver(next);
      setConfig(res.config);
      setStats(res.stats);
    } catch (err) {
      setConfig(prev);
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: TechId) {
    if (!config) return;
    void patch({ ...config, [id]: { ...config[id], enabled: !config[id].enabled } });
  }

  function setLevel(id: TechId, level: TokenSaverLevel) {
    if (!config) return;
    void patch({ ...config, [id]: { ...config[id], level, enabled: true } });
  }

  if (!config) {
    return (
      <div className="page token-saver-page">
        <PageHeader eyebrow="OPTIMIZATION" title="Token Saver" subtitle="Reduce output tokens on requests through this proxy." />
        <SkeletonRows rows={4} />
      </div>
    );
  }

  const anyOn = config.ponytail.enabled || config.caveman.enabled;
  const enabledCount = Number(config.ponytail.enabled) + Number(config.caveman.enabled);
  const requests = stats?.requests ?? 0;
  const applied = stats?.applied ?? 0;
  const tokensSaved = stats?.tokensSavedEst ?? 0;
  const coverage = requests > 0 ? Math.min(100, Math.round((applied / requests) * 100)) : 0;
  const averageSaved = applied > 0 ? Math.round(tokensSaved / applied) : 0;

  return (
    <div className="page token-saver-page">
      <PageHeader
        eyebrow="OPTIMIZATION"
        title="Token Saver"
        subtitle="Tune response efficiency for requests routed through the local proxy."
        actions={
          <span className={`ts-live-pill${anyOn ? " active" : ""}${busy ? " saving" : ""}`}>
            {busy ? <LoaderCircle className="ts-spin" size={14} /> : anyOn ? <Zap size={14} /> : <Gauge size={14} />}
            {busy ? "Saving changes" : anyOn ? `${enabledCount} technique${enabledCount === 1 ? "" : "s"} active` : "Optimization off"}
          </span>
        }
      />

      <div className="ts-wrap">
        <section className={`ts-overview${anyOn ? " on" : ""}`}>
          <div className="ts-overview-copy">
            <span className="ts-overview-icon"><Sparkles size={21} /></span>
            <div>
              <span className="ts-overview-kicker">Output efficiency</span>
              <h2>{anyOn ? "Savings engine online" : "Savings engine paused"}</h2>
              <p>{anyOn ? "Active profiles shape leaner responses while preserving prompt intent and complete code." : "Enable a technique below to start optimizing model output."}</p>
            </div>
          </div>

          <div className="ts-saved-total">
            <span>Estimated output saved</span>
            <strong>~{tokensSaved.toLocaleString()}</strong>
            <small>tokens this session</small>
          </div>

          <div className="ts-overview-meter">
            <span style={{ width: `${coverage}%` }} />
          </div>
          <div className="ts-overview-foot">
            <span><Activity size={14} />{coverage}% request coverage</span>
            <span><ShieldCheck size={14} />Prompt untouched</span>
          </div>
        </section>

        <div className="ts-stats">
          <div className="ts-stat">
            <span className="ts-stat-icon"><CheckCircle2 size={17} /></span>
            <div>
              <span className="ts-stat-num">{applied.toLocaleString()}</span>
              <span className="ts-stat-lbl">Requests optimized</span>
            </div>
          </div>
          <div className="ts-stat">
            <span className="ts-stat-icon"><Gauge size={17} /></span>
            <div>
              <span className="ts-stat-num">{coverage}%</span>
              <span className="ts-stat-lbl">Coverage</span>
            </div>
          </div>
          <div className="ts-stat">
            <span className="ts-stat-icon"><TrendingDown size={17} /></span>
            <div>
              <span className="ts-stat-num">~{averageSaved.toLocaleString()}</span>
              <span className="ts-stat-lbl">Avg. tokens saved</span>
            </div>
          </div>
          <div className="ts-stat">
            <span className="ts-stat-icon"><Activity size={17} /></span>
            <div>
              <span className="ts-stat-num">{requests.toLocaleString()}</span>
              <span className="ts-stat-lbl">Requests observed</span>
            </div>
          </div>
        </div>

        <section className="ts-techniques">
          <div className="ts-section-head">
            <div>
              <span className="ts-section-icon"><Layers3 size={16} /></span>
              <div>
                <strong>Optimization profiles</strong>
                <span>Each technique can run independently</span>
              </div>
            </div>
            <span>{enabledCount}/2 enabled</span>
          </div>

          <div className="ts-tech-grid">
            {TECHS.map((tech) => {
              const current = config[tech.id];
              const levelMeta = LEVEL_META[current.level];
              const techniqueUses = stats?.[tech.id] ?? 0;
              return (
                <article
                  key={tech.id}
                  className={`ts-card${current.enabled ? " on" : ""}`}
                  style={{ "--ts-accent": tech.color } as CSSProperties}
                >
                  <div className="ts-card-head">
                    <div className="ts-card-identity">
                      <span className="ts-tech-icon">
                        {tech.id === "caveman" ? <MessageSquareText size={20} /> : <Layers3 size={20} />}
                      </span>
                      <div className="ts-card-title">
                        <span className="ts-tag">{tech.tag}</span>
                        <strong>{tech.name}</strong>
                      </div>
                    </div>
                    <div className="ts-card-controls">
                      <span className={`ts-tech-state${current.enabled ? " active" : ""}`}>
                        {current.enabled ? `${levelMeta.label} profile` : "Disabled"}
                      </span>
                      <Switch on={current.enabled} busy={busy} label={tech.name} onToggle={() => toggle(tech.id)} />
                    </div>
                  </div>

                  <p className="ts-blurb">{tech.blurb}</p>

                  <div className={`ts-levels${current.enabled ? "" : " dim"}`} role="group" aria-label={`${tech.name} intensity`}>
                    {LEVELS.map((level) => {
                      const meta = LEVEL_META[level];
                      const active = current.level === level && current.enabled;
                      return (
                        <button
                          key={level}
                          type="button"
                          className={`ts-level${active ? " active" : ""}`}
                          disabled={busy}
                          onClick={() => setLevel(tech.id, level)}
                          aria-pressed={active}
                        >
                          <span className="ts-level-top">
                            <span className="ts-level-name">{meta.label}</span>
                            <span className="ts-level-bars" aria-hidden="true">
                              {[1, 2, 3].map((bar) => <i key={bar} className={bar <= meta.bars ? "filled" : ""} />)}
                            </span>
                          </span>
                          <span className="ts-level-tone">{meta.tone}</span>
                          <span className="ts-level-desc">{tech.levelDesc[level]}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="ts-tech-usage">
                    <span><Activity size={13} />Used on {techniqueUses.toLocaleString()} requests</span>
                    <span className={current.enabled ? "active" : ""}>{current.enabled ? "Active now" : "Standby"}</span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="ts-scope">
          <div className="ts-scope-main">
            <span className="ts-scope-icon"><Route size={18} /></span>
            <div>
              <strong>Local proxy scope</strong>
              <span>Applies to requests routed through the app proxy hop.</span>
            </div>
          </div>
          <div className="ts-scope-targets" aria-label="Supported request sources">
            <span>Chat</span>
            <span>VS Code</span>
            <span>JetBrains</span>
          </div>
          <div className="ts-safety">
            <span><ShieldCheck size={14} />Prompt unchanged</span>
            <span><Code2 size={14} />Code preserved</span>
          </div>
        </section>
      </div>
    </div>
  );
}
