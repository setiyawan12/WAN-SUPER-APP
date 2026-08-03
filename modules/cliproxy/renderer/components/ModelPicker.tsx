import { useEffect, useRef, useState } from "react";
import type { ModelEntry } from "../api/client";

// HANDBOOK M3 §5. Searchable model dropdown with vision/thinking badges —
// replaces the plain <select> so capabilities are visible at a glance. Purely
// presentational: the parent owns the selected id (conversation.model), so
// switching mid-chat just changes which model answers the next turn.
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  up,
}: {
  models: ModelEntry[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === value);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const list = q
    ? models.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
    : models;

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className={`model-picker ${up ? "up" : ""}`} ref={rootRef}>
      <button
        className="text-input model-picker-btn"
        disabled={disabled || !models.length}
        onClick={() => setOpen((o) => !o)}
        title={current?.id}
      >
        <span className="model-picker-current">
          {current?.label ?? (models.length ? "Select model" : "No enabled models")}
        </span>
        <span className="model-picker-caret">▾</span>
      </button>
      {open && (
        <div className="model-picker-menu">
          <input
            className="text-input model-picker-search"
            autoFocus
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="model-picker-list">
            {list.length === 0 && <div className="model-picker-empty">No matches</div>}
            {list.map((m) => (
              <button
                key={m.id}
                className={`model-picker-item ${m.id === value ? "active" : ""}`}
                // Select on mousedown (before the outside-mousedown close handler
                // fires) so a plain mouse click reliably picks. preventDefault
                // keeps focus in place; onClick stays for keyboard (Enter).
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m.id);
                }}
                onClick={() => pick(m.id)}
              >
                <span className="model-picker-item-label" title={m.id}>
                  {m.label}
                </span>
                <span className="model-picker-badges">
                  {m.combo && <span className="badge neutral">Combo</span>}
                  {m.capabilities?.vision === true && <span className="badge success">Vision</span>}
                  {m.thinking && <span className="badge neutral">Thinking</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
