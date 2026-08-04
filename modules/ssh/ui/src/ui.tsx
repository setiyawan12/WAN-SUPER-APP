import type { ButtonHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";
import type { Environment } from "./types";

export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
}

export function Modal({ title, children, onClose, width = 620, footer }: { title: string; children: ReactNode; onClose: () => void; width?: number; footer?: ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2>{title}</h2>
          <IconButton label="Tutup" onClick={onClose}><X size={17} /></IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

export function EnvironmentBadge({ environment }: { environment: Environment }) {
  if (environment === "none") return null;
  const label = environment === "staging" ? "STG" : environment.toUpperCase();
  return <span className={`environment-badge ${environment}`}>{label}</span>;
}

export function StatusDot({ state }: { state: string }) {
  const tone = state === "connected" || state === "idle" || state === "completed"
    ? "ok"
    : state === "error" || state === "failed"
      ? "danger"
      : state === "disconnected" || state === "closed" || state === "canceled"
        ? "muted"
        : "warn";
  return <span className={`status-dot ${tone}`} aria-hidden="true" />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; ariaLabel: string }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatRelativeTime(timestamp: number | null | undefined) {
  if (!timestamp) return "Belum pernah";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "Baru saja";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} menit lalu`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} jam lalu`;
  return `${Math.floor(diff / 86_400_000)} hari lalu`;
}