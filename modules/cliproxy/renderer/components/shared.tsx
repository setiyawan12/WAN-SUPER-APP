import type { ReactNode } from "react";
import type { DayUsage, UsageAccount, UsageApiKey } from "../api/client";
import { maskEmail } from "../lib/utils";

/** Page header with a gradient eyebrow, title, subtitle and optional actions. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {subtitle && <p className="page-hint">{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

/** Icon-chip + title/subtitle header used at the top of content cards. */
export function CardHead({
  icon,
  title,
  subtitle,
  right,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="card-head">
      <span className="card-ico">{icon}</span>
      <div className="grow">
        <div className="ct">{title}</div>
        {subtitle && <div className="cs">{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

/** Metric card: icon, big gradient number, hint, optional click-through. */
export function KpiCard({
  label,
  value,
  hint,
  warning,
  icon,
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  warning?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      className={`card metric ${warning ? "warn" : ""} ${onClick ? "clickable" : ""}`}
      onClick={onClick}
    >
      <div className="metric-top">
        {icon && <span className="metric-icon">{icon}</span>}
        <span className="metric-label">{label}</span>
        {onClick && (
          <span className="metric-arrow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
        )}
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-hint">{hint}</div>
    </div>
  );
}

/** Circular progress ring showing a 0-100 percentage. */
export function ProgressRing({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="ring" style={{ ["--p" as string]: p }}>
      <span>{p}%</span>
    </div>
  );
}

/** Friendly empty state with an icon. */
export function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="ei">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/** Compact one-line health row -- shared by Overview's summary and Models' provider list. */
export function HealthRow({ usage, revealed = false }: { usage: UsageAccount | UsageApiKey; revealed?: boolean }) {
  const isAccount = "label" in usage;
  const critical = isAccount && (usage.disabled || usage.unavailable);
  const reason = !isAccount ? "Available" : usage.disabled ? "Inactive" : usage.unavailable ? "Quota exceeded" : "Available";
  const rawLabel = isAccount ? usage.label : usage.name || usage.keyMasked;
  const label = isAccount && !revealed ? maskEmail(rawLabel) : rawLabel;

  return (
    <div className="health-row">
      <span className={`health-dot ${critical ? "bad" : "ok"}`} />
      <span className="health-label">{label}</span>
      <span className="card-desc">{reason}</span>
    </div>
  );
}

export function TrendChart({ byDay }: { byDay: DayUsage[] }) {
  const max = Math.max(1, ...byDay.map((d) => d.total_tokens));
  return (
    <div className="trend-chart">
      {byDay.map((d) => {
        const pct = Math.max(2, (d.total_tokens / max) * 100);
        return (
          <div key={d.day} className="trend-bar-col" title={`${d.day}: ${d.total_tokens.toLocaleString()} tokens, ${d.requests} requests`}>
            <div className="trend-bar-track">
              <div className="trend-bar" style={{ height: `${pct}%` }} />
            </div>
            <span className="trend-day">{d.day.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Checklist({ items }: { items: { label: string; done: boolean }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((c) => (
        <div key={c.label} className="checklist-item">
          <span className={`checklist-dot ${c.done ? "done" : ""}`}>{c.done ? "✓" : ""}</span>
          <span style={{ opacity: c.done ? 1 : 0.7 }}>{c.label}</span>
        </div>
      ))}
    </div>
  );
}
