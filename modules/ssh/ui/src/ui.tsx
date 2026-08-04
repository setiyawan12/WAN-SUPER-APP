import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
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

type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
};

type ConfirmState = ConfirmOptions & { resolve: (value: boolean) => void };

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setState({ ...options, resolve }));
  }, []);

  const close = useCallback((value: boolean) => {
    setState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!state) return;
    confirmButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(false); }
      if (event.key === "Enter") { event.preventDefault(); close(true); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="confirm-backdrop" role="presentation" onMouseDown={() => close(false)}>
          <div className={`confirm-dialog ${state.tone === "danger" ? "danger" : ""}`} role="alertdialog" aria-modal="true" aria-label={state.title} onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-icon"><AlertTriangle size={19} /></div>
            <h3 className="confirm-title">{state.title}</h3>
            {state.message && <p className="confirm-message">{state.message}</p>}
            <div className="confirm-actions">
              <button className="button" onClick={() => close(false)}>{state.cancelLabel ?? "Batal"}</button>
              <button ref={confirmButtonRef} className={`button ${state.tone === "danger" ? "danger" : "primary"}`} onClick={() => close(true)}>{state.confirmLabel ?? "OK"}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm harus dipakai di dalam ConfirmProvider");
  return confirm;
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