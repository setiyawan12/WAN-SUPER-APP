import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { useEmailReveal } from "../hooks/useEmailReveal";
import { formatCompactNumber, formatNumber } from "../lib/utils";
import {
  KpiCard,
  HealthRow,
  TrendChart,
  Checklist,
  PageHeader,
  CommandSummary,
  CardHead,
  ProgressRing,
  EmptyState,
} from "../components/shared";
import { toast } from "../components/ui";

const TOKEN_USAGE_DAYS = 7;

const sv = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const IconKey = <svg {...sv}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.5 12.5 20 3" /><path d="M15 3h5v5" /></svg>;
const IconLayers = <svg {...sv}><path d="M12 2 3 7l9 5 9-5-9-5Z" /><path d="M3 12l9 5 9-5" /><path d="M3 17l9 5 9-5" /></svg>;
const IconPulse = <svg {...sv}><path d="M3 12h4l2 6 4-14 2 8h6" /></svg>;
const IconBolt = <svg {...sv}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>;
const IconServer = <svg {...sv}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
const IconCheck = <svg {...sv}><path d="M20 6 9 17l-5-5" /></svg>;
const IconHeart = <svg {...sv}><path d="M19 14c1.5-1.5 3-3.3 3-5.5A4.5 4.5 0 0 0 12 6 4.5 4.5 0 0 0 2 8.5C2 12 6 15 12 20c2-1.7 4-3.3 5-4.5" /></svg>;
const IconChart = <svg {...sv}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="0.6" /><rect x="12.5" y="7" width="3" height="10" rx="0.6" /><rect x="18" y="13" width="3" height="4" rx="0.6" /></svg>;
const IconActivity = <svg {...sv}><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>;
const IconTrophy = <svg {...sv}><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></svg>;

function Stat({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-k">{k}</div>
      <div className="stat-v">{v}</div>
    </div>
  );
}

function SplitBar({ success, failed }: { success: number; failed: number }) {
  const total = success + failed || 1;
  const sPct = Math.round((success / total) * 100);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8em", marginBottom: 6 }}>
        <span style={{ color: "var(--wan-green)" }}>{formatNumber(success)} ok</span>
        <span style={{ color: failed > 0 ? "var(--wan-red)" : "var(--wan-faint)" }}>{formatNumber(failed)} failed</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${sPct}%`, background: "linear-gradient(90deg, #34d399, #10b981)" }} />
      </div>
    </div>
  );
}

function BarList({ items }: { items: { key: string; label: string; sub: string; value: number; valueLabel: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {items.map((i) => (
        <div key={i.key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
            <span className="model-row-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {i.label}
            </span>
            <span className="card-desc" style={{ flexShrink: 0 }}>{i.valueLabel}</span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(i.value / max) * 100}%`, background: "var(--wan-accent-grad)" }} />
          </div>
          <span className="card-desc" style={{ fontSize: "0.74em" }}>{i.sub}</span>
        </div>
      ))}
    </div>
  );
}

function Donut({ percent, label }: { percent: number; label: string }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const R = 32;
  const C = 2 * Math.PI * R;
  const off = C * (1 - p / 100);
  return (
    <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
      <svg width="84" height="84" viewBox="0 0 84 84">
        <defs>
          <linearGradient id="donutGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#6366f1" />
          </linearGradient>
        </defs>
        <circle cx="42" cy="42" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
        <circle
          cx="42"
          cy="42"
          r={R}
          fill="none"
          stroke="url(#donutGrad)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={off}
          transform="rotate(-90 42 42)"
          style={{ transition: "stroke-dashoffset 0.7s cubic-bezier(0.3,0.8,0.3,1)" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div style={{ fontSize: "1.2em", fontWeight: 720 }}>{p}%</div>
          <div className="card-desc" style={{ fontSize: "0.62em", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
        </div>
      </div>
    </div>
  );
}

export function Overview({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { data: status, mutate: refreshStatus } = usePolling(api.getStatus, 4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyElapsed, setBusyElapsed] = useState(0);
  const { revealed } = useEmailReveal();

  const { data: ownLogs } = usePolling(api.getOwnLogs, 1500, busy === "install");
  const lastLogLine = ownLogs?.lines?.[ownLogs.lines.length - 1];

  useEffect(() => {
    if (busy === null) {
      setBusyElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setBusyElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const serverRunning = status?.running ?? false;
  const { data: models } = usePolling(api.getModels, 15000, serverRunning);
  const { data: usage } = usePolling(api.getUsage, 10000, serverRunning);
  const { data: tokenData } = usePolling(() => api.getUsageTokens(TOKEN_USAGE_DAYS), 20000, serverRunning);

  const ACTION_LABEL: Record<string, string> = {
    install: "Binary installed",
    start: "Server started",
    stop: "Server stopped",
    restart: "Server restarted",
  };

  async function run(action: string, fn: () => Promise<unknown>) {
    setBusy(action);
    try {
      await fn();
      toast.success(ACTION_LABEL[action] ?? "Done");
    } catch (e) {
      toast.error(`${action} failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusy(null);
      refreshStatus(undefined, true);
    }
  }

  const credentials = [...(usage?.accounts ?? []), ...(usage?.apiKeys ?? [])];
  const unavailableCount = (usage?.accounts ?? []).filter((a) => a.disabled || a.unavailable).length;
  const availableCount = credentials.length - unavailableCount;

  const enabledModels = models?.models.filter((m) => m.enabled).length ?? 0;
  const totalModels = models?.models.length ?? 0;

  const totalRequests = (usage?.totals.success ?? 0) + (usage?.totals.failed ?? 0);
  const successRate = totalRequests > 0 ? Math.round(((usage?.totals.success ?? 0) / totalRequests) * 100) : null;

  const tk = tokenData?.totals;
  const tokens7d = tk?.total_tokens ?? 0;
  const cacheRate = tk && tk.input_tokens > 0 ? Math.round((tk.cached_tokens / tk.input_tokens) * 100) : 0;
  const rate7d = tk && tk.requests > 0 ? Math.round(((tk.requests - tk.failed) / tk.requests) * 100) : null;

  const topModels = (tokenData?.byProviderModel ?? [])
    .slice()
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 5)
    .map((m) => ({
      key: `${m.provider}/${m.model}`,
      label: m.model,
      sub: `${m.provider} · ${formatNumber(m.requests)} req`,
      value: m.total_tokens,
      valueLabel: `${formatCompactNumber(m.total_tokens)} tok`,
    }));

  const checklist = [
    { label: "Binary installed", done: !!status?.binaryInstalled },
    { label: "Server running", done: serverRunning },
    { label: "At least 1 account / API key connected", done: credentials.length > 0 },
    { label: "At least 1 model enabled", done: enabledModels > 0 },
  ];
  const doneCount = checklist.filter((c) => c.done).length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Dashboard"
        title="Overview"
        subtitle="Server, accounts, models, and usage at a glance."
        actions={
          <button className="btn" disabled={busy !== null || serverRunning} onClick={() => run("start", api.start)}>
            {busy === "start" ? "Starting…" : serverRunning ? "Server running" : "Start server"}
          </button>
        }
      />

      <CommandSummary
        tone={serverRunning ? "green" : "amber"}
        icon={IconServer}
        eyebrow="Local model gateway"
        title={serverRunning ? "CLIProxyAPI is online and routing" : "CLIProxyAPI is currently stopped"}
        description="One control surface for server health, connected credentials, published models, and request telemetry."
        status={
          <span className={`command-status-pill ${serverRunning ? "success" : "neutral"}`}>
            {serverRunning ? IconCheck : IconServer}
            {serverRunning ? `PID ${status?.pid ?? "—"}` : "Start required"}
          </span>
        }
        metrics={[
          { label: "accounts ready", value: credentials.length ? `${availableCount}/${credentials.length}` : "0", tone: unavailableCount ? "warn" : availableCount ? "success" : "default" },
          { label: "models enabled", value: totalModels ? `${enabledModels}/${totalModels}` : "0" },
          { label: "success rate", value: successRate === null ? "—" : `${successRate}%`, tone: successRate !== null && successRate >= 95 ? "success" : successRate !== null && successRate < 90 ? "warn" : "default" },
          { label: `tokens · ${TOKEN_USAGE_DAYS}d`, value: tokens7d ? formatCompactNumber(tokens7d) : "—" },
        ]}
      />

      <div className="grid">
        <KpiCard
          icon={IconKey}
          label="Accounts & API keys"
          value={credentials.length ? `${availableCount}/${credentials.length}` : "—"}
          hint={credentials.length ? "available / total" : "Nothing connected yet"}
          warning={unavailableCount > 0}
          onClick={() => onNavigate("providers")}
        />
        <KpiCard
          icon={IconLayers}
          label="Active models"
          value={totalModels ? `${enabledModels}/${totalModels}` : "—"}
          hint={totalModels ? "enabled / total" : "Server isn't running"}
          onClick={() => onNavigate("models")}
        />
        <KpiCard
          icon={IconPulse}
          label="Requests (last ~3.3h)"
          value={totalRequests ? formatNumber(totalRequests) : "—"}
          hint={successRate !== null ? `${successRate}% success` : "No data yet"}
          warning={successRate !== null && successRate < 90}
          onClick={() => onNavigate("usage")}
        />
        <KpiCard
          icon={IconBolt}
          label={`Tokens · ${TOKEN_USAGE_DAYS}d`}
          value={tokens7d ? formatCompactNumber(tokens7d) : "—"}
          hint={tokens7d ? `${cacheRate}% served from cache` : "No token data yet"}
          onClick={() => onNavigate("usage")}
        />
      </div>

      <div className="cols c-3-2">
        <div className="card accent pad-lg">
          <CardHead
            icon={IconServer}
            title="CLIProxyAPI server"
            subtitle={status?.home ?? "—"}
            right={
              <span className={`badge ${status?.running ? "success" : "neutral"}`}>
                {status?.running ? "Running" : "Stopped"}
              </span>
            }
          />
          <div className="stat-grid">
            <Stat k="Binary" v={status?.binaryInstalled ? "Installed" : "Not installed"} />
            <Stat k="Process" v={status?.pid ? `PID ${status.pid}` : "—"} />
            <div className="stat" style={{ gridColumn: "1 / -1" }}>
              <div className="stat-k">Last error</div>
              <div className="stat-v">{status?.lastStartError ?? "None"}</div>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn secondary" disabled={busy !== null} onClick={() => run("install", api.install)}>
              {busy === "install" ? `Installing… (${busyElapsed}s)` : "Install / Update binary"}
            </button>
            <button className="btn" disabled={busy !== null || status?.running} onClick={() => run("start", api.start)}>
              {busy === "start" ? "Starting…" : "Start"}
            </button>
            <button className="btn secondary" disabled={busy !== null || !status?.running} onClick={() => run("stop", api.stop)}>
              {busy === "stop" ? "Stopping…" : "Stop"}
            </button>
            <button className="btn secondary" disabled={busy !== null} onClick={() => run("restart", api.restart)}>
              {busy === "restart" ? "Restarting…" : "Restart"}
            </button>
          </div>
          {busy === "install" && (
            <div className="mono-chip">{lastLogLine ? lastLogLine.replace(/^\[[^\]]+\]\s*/, "") : "Starting install…"}</div>
          )}
        </div>

        <div className="card pad-lg">
          <CardHead
            icon={IconCheck}
            title="Setup"
            subtitle={`${doneCount} of ${checklist.length} steps done`}
            right={<ProgressRing percent={(doneCount / checklist.length) * 100} />}
          />
          <Checklist items={checklist} />
        </div>
      </div>

      <div className="cols c-2">
        <div className="card">
          <CardHead icon={IconActivity} title={`Requests & tokens · ${TOKEN_USAGE_DAYS}d`} subtitle="Success rate and token split" />
          {!serverRunning && <EmptyState icon={IconActivity}>Server isn't running.</EmptyState>}
          {serverRunning && !tk && <EmptyState icon={IconActivity}>No request data yet.</EmptyState>}
          {serverRunning && tk && (
            <>
              <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
                <Donut percent={rate7d ?? 100} label="success" />
                <div className="stat-grid" style={{ flex: 1 }}>
                  <Stat k="Input tokens" v={formatCompactNumber(tk.input_tokens)} />
                  <Stat k="Output tokens" v={formatCompactNumber(tk.output_tokens)} />
                  <Stat k="Cache rate" v={`${cacheRate}%`} />
                  <Stat k="Requests" v={formatNumber(tk.requests)} />
                </div>
              </div>
              <div style={{ marginTop: "auto" }}>
                <SplitBar success={Math.max(0, tk.requests - tk.failed)} failed={tk.failed} />
              </div>
            </>
          )}
        </div>

        <div className="card">
          <CardHead icon={IconTrophy} title={`Top models · ${TOKEN_USAGE_DAYS}d`} subtitle="Most tokens used" />
          {!serverRunning && <EmptyState icon={IconTrophy}>Server isn't running.</EmptyState>}
          {serverRunning && topModels.length === 0 && <EmptyState icon={IconLayers}>No model usage recorded yet.</EmptyState>}
          {serverRunning && topModels.length > 0 && <BarList items={topModels} />}
        </div>
      </div>

      <div className="card">
        <CardHead
          icon={IconChart}
          title={`Token usage · ${TOKEN_USAGE_DAYS}d`}
          subtitle="Total tokens per day, per provider"
          right={
            serverRunning && tokenData && tokenData.byDay.length > 0 ? (
              <a className="link" onClick={() => onNavigate("usage")}>
                View detail →
              </a>
            ) : undefined
          }
        />
        {!serverRunning && <EmptyState icon={IconChart}>Server isn't running.</EmptyState>}
        {serverRunning && (!tokenData || tokenData.byDay.length === 0) && (
          <EmptyState icon={IconChart}>No token usage data yet.</EmptyState>
        )}
        {serverRunning && tokenData && tokenData.byDay.length === 1 && (
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Stat k="Tokens today" v={formatCompactNumber(tokenData.byDay[0].total_tokens)} />
            <Stat k="Requests today" v={formatNumber(tokenData.byDay[0].requests)} />
            <Stat k={`Total · ${TOKEN_USAGE_DAYS}d`} v={formatCompactNumber(tokens7d)} />
            <Stat k="Cache rate" v={`${cacheRate}%`} />
          </div>
        )}
        {serverRunning && tokenData && tokenData.byDay.length > 1 && <TrendChart byDay={tokenData.byDay} />}
      </div>

      <div className="card">
        <CardHead
          icon={IconHeart}
          title="Health monitor"
          subtitle="Account & API key status"
          right={
            credentials.length > 8 ? (
              <a className="link" onClick={() => onNavigate("usage")}>
                View all ({credentials.length}) →
              </a>
            ) : undefined
          }
        />
        {!serverRunning && (
          <EmptyState icon={IconServer}>Server isn't running, so there's no account health data.</EmptyState>
        )}
        {serverRunning && credentials.length === 0 && (
          <EmptyState icon={IconKey}>No accounts or API keys connected yet.</EmptyState>
        )}
        {serverRunning && credentials.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 8 }}>
            {(usage?.accounts ?? []).slice(0, 8).map((a) => (
              <HealthRow key={a.name} usage={a} revealed={revealed} />
            ))}
            {(usage?.apiKeys ?? []).slice(0, Math.max(0, 8 - (usage?.accounts?.length ?? 0))).map((k, i) => (
              <HealthRow key={`${k.provider}-${i}`} usage={k} revealed={revealed} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
