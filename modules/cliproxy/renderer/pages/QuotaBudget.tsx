import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Route,
  Save,
  ShieldAlert,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  api,
  type BudgetWindowStatus,
  type QuotaBudgetAlert,
  type QuotaBudgetCenterResponse,
  type QuotaBudgetConfig,
  type QuotaBudgetCredential,
  type QuotaBudgetProvider,
  type QuotaWindowStatus,
} from "../api/client";
import { CommandSummary, PageHeader } from "../components/shared";
import { SkeletonRows, toast } from "../components/ui";
import { formatCompactNumber, formatUsd, maskEmail } from "../lib/utils";

const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  xai: "xAI (Grok)",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function dateTime(epochMs: number | null): string {
  if (!epochMs) return "Unknown";
  return new Date(epochMs).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function countdown(epochMs: number | null): string {
  if (!epochMs) return "No reset reported";
  const minutes = Math.max(0, Math.round((epochMs - Date.now()) / 60_000));
  if (minutes <= 0) return "Due now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

function percent(value: number): string {
  return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
}

export function QuotaBudget() {
  const [data, setData] = useState<QuotaBudgetCenterResponse | null>(null);
  const [draft, setDraft] = useState<QuotaBudgetConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const response = await api.getQuotaBudgetCenter();
      setData(response);
      if (!dirty) setDraft(response.config);
    } catch (error) {
      if (!silent) toast.error(errorMessage(error));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
    // `dirty` intentionally controls whether polling may replace the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  function patchConfig(patch: Partial<QuotaBudgetConfig>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
  }

  function patchProvider(provider: string, key: "dailyUsd" | "monthlyUsd", value: number) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        providerBudgets: {
          ...current.providerBudgets,
          [provider]: {
            dailyUsd: current.providerBudgets[provider]?.dailyUsd || 0,
            monthlyUsd: current.providerBudgets[provider]?.monthlyUsd || 0,
            [key]: Math.max(0, value || 0),
          },
        },
      };
    });
    setDirty(true);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await api.setQuotaBudgetConfig(draft);
      setData(response);
      setDraft(response.config);
      setDirty(false);
      toast.success("Quota & budget policy saved");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function checkNow() {
    setChecking(true);
    try {
      const response = await api.checkQuotaBudget();
      setData(response.center);
      if (!dirty) setDraft(response.center.config);
      toast.info(response.emitted.length ? `${response.emitted.length} new alert${response.emitted.length === 1 ? "" : "s"} emitted` : "Threshold check complete — no new alerts");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  const criticalProviders = useMemo(
    () => data?.providers.filter((row) => ["warning", "critical", "exhausted"].includes(row.daily.status) || ["warning", "critical", "exhausted"].includes(row.monthly.status)).length || 0,
    [data]
  );
  const liveQuotaCredentials = data?.credentials.filter((credential) => credential.quota?.ok) || [];
  const quotaAtRisk = liveQuotaCredentials.filter((credential) => {
    if (!credential.quota?.ok) return false;
    return [credential.quota.primary, credential.quota.secondary].some((window) => (window?.usedPercent || 0) >= 80 || window?.prediction.beforeReset);
  }).length;
  const configuredProviders = draft
    ? Object.values(draft.providerBudgets).filter((budget) => budget.dailyUsd > 0 || budget.monthlyUsd > 0).length
    : 0;

  if (loading || !data || !draft) {
    return (
      <div className="page quota-budget-page">
        <PageHeader eyebrow="GUARDRAILS" title="Quota & Budget" subtitle="Track account windows, provider spend, alerts, and resets." />
        <SkeletonRows rows={6} />
      </div>
    );
  }

  return (
    <div className="page quota-budget-page">
      <PageHeader
        eyebrow="GUARDRAILS"
        title="Quota & Budget"
        subtitle="Track real account quota where available, enforce estimated provider budgets, and route Combo traffic away from exhausted spend."
        actions={
          <>
            <button className="btn secondary" type="button" disabled={checking} onClick={() => void checkNow()}>
              {checking ? <LoaderCircle className="qbc-spin" size={15} /> : <RefreshCw size={15} />}
              Check now
            </button>
            <button className="btn" type="button" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? <LoaderCircle className="qbc-spin" size={15} /> : <Save size={15} />}
              {saving ? "Saving" : "Save policy"}
            </button>
          </>
        }
      />

      <CommandSummary
        tone={criticalProviders || quotaAtRisk ? "amber" : "green"}
        icon={criticalProviders || quotaAtRisk ? <ShieldAlert size={21} /> : <CheckCircle2 size={21} />}
        eyebrow="Quota guard"
        title={criticalProviders || quotaAtRisk ? `${criticalProviders + quotaAtRisk} guardrail${criticalProviders + quotaAtRisk === 1 ? "" : "s"} need attention` : "Quota and budget guardrails are healthy"}
        description="Live 5-hour/weekly quota currently comes from Codex accounts. Daily/monthly values are WAN cost estimates from recorded tokens."
        status={<span className={`command-status-pill ${draft.enabled ? "success" : "neutral"}`}><Gauge size={13} />{draft.enabled ? "Monitoring active" : "Monitoring paused"}</span>}
        metrics={[
          { label: "live quota", value: liveQuotaCredentials.length },
          { label: "quota at risk", value: quotaAtRisk, tone: quotaAtRisk ? "warn" : "default" },
          { label: "budget alerts", value: criticalProviders, tone: criticalProviders ? "warn" : "default" },
          { label: "budgeted providers", value: configuredProviders },
        ]}
      />

      <section className="qbc-policy-strip">
        <PolicyToggle
          icon={<Gauge size={17} />}
          title="Monitoring"
          description="Evaluate quota and configured budgets every minute."
          checked={draft.enabled}
          onChange={(enabled) => patchConfig({ enabled })}
        />
        <PolicyToggle
          icon={draft.notificationsEnabled ? <Bell size={17} /> : <BellOff size={17} />}
          title="OS alerts"
          description="Notify at 80%, 90%, and exhausted."
          checked={draft.notificationsEnabled}
          onChange={(notificationsEnabled) => patchConfig({ notificationsEnabled })}
        />
        <PolicyToggle
          icon={<Route size={17} />}
          title="Budget auto-route"
          description="When a Combo primary exhausts budget, prefer a cheaper healthy member."
          checked={draft.autoRouteEnabled}
          onChange={(autoRouteEnabled) => patchConfig({ autoRouteEnabled })}
        />
      </section>

      <section className="qbc-section">
        <SectionHead
          icon={<WalletCards size={18} />}
          title="Provider budgets"
          description="Estimated cost based on provider-reported input/output tokens and static public rates. A zero limit disables that window."
          right={<span className="badge neutral">USD estimate</span>}
        />
        <div className="qbc-provider-grid">
          {data.providers.map((row) => (
            <ProviderBudgetCard
              key={row.provider}
              row={row}
              budget={draft.providerBudgets[row.provider] || { dailyUsd: 0, monthlyUsd: 0 }}
              onBudget={(key, value) => patchProvider(row.provider, key, value)}
            />
          ))}
        </div>
        <div className="qbc-data-note"><AlertTriangle size={14} />{data.pricingNote}</div>
      </section>

      <section className="qbc-section">
        <SectionHead
          icon={<Gauge size={18} />}
          title="Account quota windows"
          description="Provider-reported quota, reset countdown, and burn-rate prediction. Unsupported providers remain visible without fabricated percentages."
          right={<span className="badge neutral">Codex live data</span>}
        />
        <div className="qbc-credential-list">
          {data.credentials.map((credential) => <CredentialQuotaCard key={credential.name} credential={credential} />)}
          {!data.credentials.length && <div className="qbc-empty">No connected credentials yet.</div>}
        </div>
      </section>

      <div className="qbc-lower-grid">
        <section className="qbc-section">
          <SectionHead icon={<CalendarClock size={18} />} title="Reset calendar" description="Upcoming budget, quota, and account retry events." />
          <div className="qbc-timeline">
            {data.resets.slice(0, 14).map((event) => (
              <div key={event.id} className={`qbc-reset-event ${event.kind}`}>
                <span><Clock3 size={15} /></span>
                <div><strong>{event.label}</strong><small>{event.scope}</small></div>
                <time>{countdown(event.at)}<small>{dateTime(event.at)}</small></time>
              </div>
            ))}
            {!data.resets.length && <div className="qbc-empty">No reset event is currently available.</div>}
          </div>
        </section>

        <section className="qbc-section">
          <SectionHead icon={<Bell size={18} />} title="Alert history" description="Threshold notifications are emitted once per quota or budget period." />
          <div className="qbc-alert-list">
            {data.alerts.slice(0, 12).map((alert) => <AlertRow key={alert.id} alert={alert} />)}
            {!data.alerts.length && <div className="qbc-empty">No quota or budget alerts emitted yet.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function PolicyToggle({ icon, title, description, checked, onChange }: { icon: React.ReactNode; title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={`qbc-policy-toggle${checked ? " active" : ""}`}>
      <span className="qbc-policy-icon">{icon}</span>
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" className="toggle" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SectionHead({ icon, title, description, right }: { icon: React.ReactNode; title: string; description: string; right?: React.ReactNode }) {
  return (
    <div className="qbc-section-head">
      <span>{icon}</span>
      <div><strong>{title}</strong><small>{description}</small></div>
      {right && <div className="qbc-section-right">{right}</div>}
    </div>
  );
}

function ProviderBudgetCard({ row, budget, onBudget }: { row: QuotaBudgetProvider; budget: { dailyUsd: number; monthlyUsd: number }; onBudget: (key: "dailyUsd" | "monthlyUsd", value: number) => void }) {
  const worst = [row.daily.status, row.monthly.status].includes("exhausted")
    ? "exhausted"
    : [row.daily.status, row.monthly.status].includes("critical")
      ? "critical"
      : [row.daily.status, row.monthly.status].includes("warning") ? "warning" : "ok";
  return (
    <article className={`qbc-provider-card ${worst}`}>
      <div className="qbc-provider-head">
        <div><span className="qbc-provider-mark">{providerLabel(row.provider).slice(0, 1)}</span><span><strong>{providerLabel(row.provider)}</strong><small>{formatCompactNumber(row.tokens.month)} tokens this month</small></span></div>
        <span className={`badge ${worst === "ok" ? "success" : worst === "warning" ? "warn" : "error"}`}>{worst === "ok" ? "Within guardrail" : worst}</span>
      </div>
      <BudgetWindow label="Daily" window={row.daily} value={budget.dailyUsd} onChange={(value) => onBudget("dailyUsd", value)} />
      <BudgetWindow label="Monthly" window={row.monthly} value={budget.monthlyUsd} onChange={(value) => onBudget("monthlyUsd", value)} />
      <div className="qbc-provider-foot">
        <span><TrendingUp size={13} />Projected month: {formatUsd(row.monthly.projectedUsd)}</span>
        <span>Rate: {formatUsd(row.rates.input)}/{formatUsd(row.rates.output)} per 1M</span>
      </div>
    </article>
  );
}

function BudgetWindow({ label, window, value, onChange }: { label: string; window: BudgetWindowStatus; value: number; onChange: (value: number) => void }) {
  const fill = Math.min(100, window.percent);
  return (
    <div className="qbc-budget-window">
      <div className="qbc-budget-row">
        <span><strong>{label}</strong><small>{formatUsd(window.costUsd)} spent</small></span>
        <label><span>$</span><input type="number" min={0} step="0.5" value={value || ""} placeholder="No limit" onChange={(event) => onChange(Number(event.target.value))} /></label>
      </div>
      <div className="qbc-meter"><span className={window.status} style={{ width: `${fill}%` }} /></div>
      <div className="qbc-budget-meta">
        <span>{window.budgetUsd > 0 ? `${percent(window.percent)} used` : "Limit disabled"}</span>
        <span>{window.exhaustionAt ? `Predicted exhaustion ${countdown(window.exhaustionAt)}` : `Resets ${countdown(window.resetAt)}`}</span>
      </div>
    </div>
  );
}

function CredentialQuotaCard({ credential }: { credential: QuotaBudgetCredential }) {
  const unavailable = credential.disabled || credential.unavailable;
  return (
    <article className={`qbc-credential-card${unavailable ? " unavailable" : ""}`}>
      <div className="qbc-credential-head">
        <span className={`health-dot ${unavailable ? "bad" : "ok"}`} />
        <div><strong>{maskEmail(credential.label)}</strong><small>{providerLabel(credential.provider)}{credential.quota?.ok && credential.quota.planType ? ` · ${credential.quota.planType}` : ""}</small></div>
        <span className={`badge ${unavailable ? "error" : "success"}`}>{credential.disabled ? "Disabled" : credential.unavailable ? "Unavailable" : "Available"}</span>
      </div>
      {credential.quota?.ok ? (
        <div className="qbc-quota-windows">
          {credential.quota.primary && <QuotaWindow label="5 hour" window={credential.quota.primary} tokens={credential.window5hTokens} />}
          {credential.quota.secondary && <QuotaWindow label="Weekly" window={credential.quota.secondary} tokens={credential.window7dTokens} />}
        </div>
      ) : (
        <div className="qbc-quota-unavailable">
          <Gauge size={16} />
          <span><strong>No live quota percentage</strong><small>{credential.quota && !credential.quota.ok ? credential.quota.reason : "This provider does not expose a supported quota endpoint."}</small></span>
          {credential.nextRetryAt && <time>Retry {countdown(credential.nextRetryAt)}</time>}
        </div>
      )}
    </article>
  );
}

function QuotaWindow({ label, window, tokens }: { label: string; window: QuotaWindowStatus; tokens: number }) {
  const used = window.usedPercent || 0;
  const risk = used >= 100 ? "exhausted" : used >= 90 ? "critical" : used >= 80 ? "warning" : "ok";
  return (
    <div className={`qbc-quota-window ${risk}`}>
      <div><span><strong>{label}</strong><small>{formatCompactNumber(tokens)} recorded tokens</small></span><b>{window.usedPercent === null ? "?" : `${Math.round(window.usedPercent)}%`}</b></div>
      <div className="qbc-meter"><span className={risk} style={{ width: `${Math.min(100, used)}%` }} /></div>
      <div className="qbc-quota-meta">
        <span>Reset in {countdown(window.resetAt)}</span>
        <span>{window.prediction.beforeReset && window.prediction.exhaustionAt ? `May exhaust in ${countdown(window.prediction.exhaustionAt)}` : "No pre-reset exhaustion predicted"}</span>
      </div>
    </div>
  );
}

function AlertRow({ alert }: { alert: QuotaBudgetAlert }) {
  return (
    <div className={`qbc-alert-row ${alert.severity}`}>
      <span>{alert.severity === "warning" ? <AlertTriangle size={15} /> : <ShieldAlert size={15} />}</span>
      <div><strong>{alert.title}</strong><small>{alert.message}</small></div>
      <time>{new Date(alert.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
    </div>
  );
}