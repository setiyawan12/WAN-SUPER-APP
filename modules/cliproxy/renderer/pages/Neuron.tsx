import { useEffect, useMemo, useState } from "react";
import { Activity, CircleAlert, Radio, Sparkles, Zap } from "lucide-react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { CommandSummary, PageHeader } from "../components/shared";
import { useNeuronGraph } from "./neuron/useNeuronGraph";
import { NeuronCanvas } from "./neuron/NeuronCanvas";
import { providerPalette } from "./neuron/palette";
import { stageStats } from "./neuron/overlay";

// ── helpers ────────────────────────────────────────────────────────────────────
const LEGEND = [
  { key: "anthropic", label: "Claude" },
  { key: "gemini",    label: "Gemini" },
  { key: "openai",    label: "OpenAI" },
  { key: "xai",       label: "xAI" },
];

function splitNode(id: string) {
  const i = id.indexOf("::");
  return i === -1 ? { provider: "", model: id } : { provider: id.slice(0, i), model: id.slice(i + 2) };
}
function short(s: string, n = 32): string { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function ago(ts: number | null, now: number): string {
  if (ts == null) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

// ── component ──────────────────────────────────────────────────────────────────
export function Neuron() {
  const { data: status } = usePolling(api.getStatus, 4000);
  const serverRunning = status?.running ?? false;
  const { nodes, firings, accountLabel } = useNeuronGraph(serverRunning);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const sortedNodes   = [...nodes].sort((a, b) => (b.lastHitTs ?? 0) - (a.lastHitTs ?? 0) || b.requests - a.requests);
  const recentFirings = [...firings].sort((a, b) => b.startedAt - a.startedAt).slice(0, 40);
  const maxReq        = Math.max(1, ...nodes.map((n) => n.requests));
  const stats         = useMemo(() => stageStats(nodes, firings, now), [nodes, firings, now]);

  return (
    <div className="page neuron-page">
      <PageHeader
        eyebrow="Activity"
        title="Neuron activity"
        subtitle="Live model routing visualized as a provider constellation and request pulse feed."
      />

      <CommandSummary
        icon={<Activity size={21} />}
        eyebrow="Routing telemetry"
        title={serverRunning ? stats.nodes ? `${stats.nodes} model nodes observed` : "Listening for model traffic" : "Telemetry stream offline"}
        description="Each node represents a provider/model route; live pulses identify the credential currently serving the request."
        status={
          <span className={`command-status-pill ${serverRunning ? "success" : "neutral"}`}>
            {serverRunning ? <Radio size={13} /> : <CircleAlert size={13} />}
            {serverRunning ? "Live stream" : "Server stopped"}
          </span>
        }
        metrics={[
          { label: "nodes", value: stats.nodes },
          { label: "live", value: stats.live, tone: stats.live ? "success" : "default" },
          { label: "near-live", value: stats.nearLive },
          { label: "failures", value: stats.fails, tone: stats.fails ? "error" : "default" },
          { label: "last hit", value: stats.lastHitAgo },
        ]}
      />

      {!serverRunning && (
        <div className="empty-hint">
          CLIProxyAPI isn't running. Go to Overview and click Start first.
        </div>
      )}

      {serverRunning && (
        <>
          {/* ── Canvas stage ───────────────────────────────────────────── */}
          <div className="card neuron-stage">
            <div className="neuron-stage-frame" aria-hidden />
            {/* Provider legend */}
            <div className="neuron-legend">
              {LEGEND.map((p) => (
                <span key={p.key} className="neuron-legend-item">
                  <span
                    className="neuron-dot"
                    style={{
                      background: providerPalette(p.key).accent,
                      boxShadow: `0 0 8px ${providerPalette(p.key).accent}aa`,
                    }}
                  />
                  {p.label}
                </span>
              ))}
              <span className="neuron-legend-hint">
                <span className="neuron-hint-live"><Zap size={12} />instant</span>
                <span className="neuron-hint-sep">·</span>
                <span>~ near-live</span>
                <span className="neuron-hint-sep">·</span>
                <span>LIVE = akun serve</span>
                <span className="neuron-hint-sep">·</span>
                <span>click = pin</span>
                <span className="neuron-hint-sep">·</span>
                <span>gems orbit · Stop freezes</span>
              </span>
            </div>
            <div className="neuron-stage-badge"><Sparkles size={12} />CONSTELLATION</div>
            {/* Mini stats strip */}
            <div className="neuron-stats" aria-live="polite">
              <span className="neuron-stats-item">
                <span className="neuron-stats-k">Gems</span>
                <span className="neuron-stats-v">{stats.nodes}</span>
              </span>
              <span className="neuron-stats-item hot">
                <span className="neuron-stats-k">Live</span>
                <span className="neuron-stats-v">{stats.live}</span>
              </span>
              <span className="neuron-stats-item">
                <span className="neuron-stats-k">Near</span>
                <span className="neuron-stats-v">{stats.nearLive}</span>
              </span>
              {stats.fails > 0 && (
                <span className="neuron-stats-item fail">
                  <span className="neuron-stats-k">Fail</span>
                  <span className="neuron-stats-v">{stats.fails}</span>
                </span>
              )}
              <span className="neuron-stats-item wide">
                <span className="neuron-stats-k">Last</span>
                <span className="neuron-stats-v">{stats.lastHitAgo}</span>
              </span>
            </div>
            <NeuronCanvas
              nodes={nodes}
              firings={firings}
              now={now}
              accountLabel={accountLabel}
              height={720}
            />
          </div>

          {/* ── Data panels ────────────────────────────────────────────── */}
          <div className="cols c-2">
            {/* Live activity feed */}
            <div className="card">
              <div className="card-title">Live activity</div>
              <div className="card-desc">
                Satu baris per pulse · model + akun. Grok×banyak akun: 1 gem / model, chip ganti tiap auto-switch (~15s delay path B).
              </div>
              {recentFirings.length === 0 ? (
                <p className="card-desc" style={{ marginTop: 12 }}>
                  Waiting for traffic — hit a model from VS Code, JetBrains, or in-app chat.
                </p>
              ) : (
                <div className="neuron-list">
                  {recentFirings.map((f) => {
                    const { provider, model } = splitNode(f.nodeId);
                    const accent = providerPalette(provider).accent;
                    const fail   = f.failed;
                    const account = accountLabel(f.authIndex);
                    return (
                      <div key={f.id} className="neuron-row" style={{ opacity: fail ? 0.85 : 1 }}>
                        <span className="neuron-dot" style={{ background: fail ? "#fb7185" : accent }} />
                        <span className="neuron-model" title={f.nodeId}>{short(model, 28)}</span>
                        <span
                          className={`neuron-chip${f.live ? " live" : ""}`}
                          style={f.live ? { boxShadow: `0 0 8px ${accent}55` } : {}}
                        >
                          {f.live ? <Zap size={11} /> : "~"}
                        </span>
                        {account ? (
                          <span className="neuron-account" title={account}>{short(account, 26)}</span>
                        ) : null}
                        <span className="neuron-meta">
                          {ago(f.startedAt, now)}
                          {f.latencyMs != null ? ` · ${f.latencyMs}ms` : ""}
                          {f.pending ? " · pending" : fail ? " · failed" : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Model breakdown */}
            <div className="card">
              <div className="card-title">Models · {sortedNodes.length}</div>
              <div className="card-desc">One gem per provider · model. Last account when known.</div>
              {sortedNodes.length === 0 ? (
                <p className="card-desc" style={{ marginTop: 12 }}>No models seen yet.</p>
              ) : (
                <div className="neuron-list">
                  {sortedNodes.map((n) => {
                    const accent = n.lastFailed ? "#fb7185" : providerPalette(n.provider).accent;
                    const pct    = Math.max(4, Math.round((n.requests / maxReq) * 100));
                    const account = accountLabel(n.lastAuthIndex);
                    return (
                      <div key={n.id} className="neuron-row">
                        <span className="neuron-dot" style={{ background: accent }} />
                        <span className="neuron-model" title={n.id}>{short(n.model, 22)}</span>
                        {account ? (
                          <span className="neuron-account" title={account}>{short(account, 22)}</span>
                        ) : null}
                        <span className="neuron-bar">
                          <span
                            className="neuron-bar-fill"
                            style={{ width: `${pct}%`, background: accent, boxShadow: `0 0 6px ${accent}44` }}
                          />
                        </span>
                        <span className="neuron-meta">
                          {n.requests} · {ago(n.lastHitTs, now)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
