import { useEffect, useState, type ReactNode } from "react";
import { Overview } from "./pages/Overview";
import { Chat } from "./pages/Chat";
import { Models } from "./pages/Models";
import { Providers } from "./pages/Providers";
import { Usage } from "./pages/Usage";
import { Neuron } from "./pages/Neuron";
import { Logs } from "./pages/Logs";
import { Config } from "./pages/Config";
import { VsCode } from "./pages/VsCode";
import { JetBrains } from "./pages/JetBrains";
import { Toasts } from "./components/ui";

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "usage", label: "Usage" },
  { id: "neuron", label: "Activity" },
  { id: "vscode", label: "VS Code" },
  { id: "jetbrains", label: "JetBrains" },
  { id: "logs", label: "Logs" },
  { id: "config", label: "Config" },
] as const;

type PageId = (typeof PAGES)[number]["id"];

function isPageId(value: unknown): value is PageId {
  return PAGES.some((p) => p.id === value);
}

// Inline stroke icons (no icon-library dependency). 18px, currentColor.
const s = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const ICONS: Record<PageId, ReactNode> = {
  overview: (
    <svg {...s}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
  ),
  chat: (
    <svg {...s}><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5.6a8.5 8.5 0 0 1-.9-3.9A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" /></svg>
  ),
  providers: (
    <svg {...s}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.5 12.5 20 3" /><path d="M15 3h5v5" /></svg>
  ),
  models: (
    <svg {...s}><path d="M12 2 3 7l9 5 9-5-9-5Z" /><path d="M3 12l9 5 9-5" /><path d="M3 17l9 5 9-5" /></svg>
  ),
  usage: (
    <svg {...s}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="0.6" /><rect x="12.5" y="7" width="3" height="10" rx="0.6" /><rect x="18" y="13" width="3" height="4" rx="0.6" /></svg>
  ),
  neuron: (
    <svg {...s}><circle cx="12" cy="12" r="2.4" /><circle cx="5" cy="6" r="1.6" /><circle cx="19" cy="7" r="1.6" /><circle cx="6" cy="18" r="1.6" /><circle cx="18" cy="17" r="1.6" /><path d="M10.2 10.6 6.3 7M13.8 10.7 17.5 8M10.5 13.6 7.2 16.7M13.6 13.7 16.7 16.2" /></svg>
  ),
  vscode: (
    <svg {...s}><path d="m9 8-5 4 5 4" /><path d="m15 8 5 4-5 4" /></svg>
  ),
  jetbrains: (
    <svg {...s}><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M7 16.5h6" /><path d="M9 8v5a2 2 0 0 1-2 2" /></svg>
  ),
  logs: (
    <svg {...s}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 2.5 2L7 13" /><path d="M12.5 14H16" /></svg>
  ),
  config: (
    <svg {...s}><path d="M4 6h10" /><path d="M20 6h-2" /><circle cx="16" cy="6" r="2" /><path d="M4 18h4" /><path d="M14 18h6" /><circle cx="10" cy="18" r="2" /><path d="M4 12h2" /><path d="M12 12h8" /><circle cx="8" cy="12" r="2" /></svg>
  ),
};

interface HealthLike {
  available?: number;
  unavailable?: number;
  reachable?: boolean;
  entries?: unknown[];
}

export function App() {
  const [page, setPage] = useState<PageId>("overview");
  const [health, setHealth] = useState<HealthLike | null>(null);

  useEffect(() => {
    void window.wan.health().then((h) => setHealth(h as HealthLike));
    const off = window.wan.onEvent((ev) => {
      if (ev.type === "health") setHealth(ev.payload as HealthLike);
    });
    return off;
  }, []);

  const label = PAGES.find((p) => p.id === page)?.label ?? "";

  let footClass = "foot-dot";
  let footText = "Connecting…";
  if (health) {
    if (!health.reachable) {
      footClass = "foot-dot bad";
      footText = "Server offline";
    } else if ((health.entries?.length ?? 0) === 0) {
      footText = "No accounts";
    } else if ((health.unavailable ?? 0) > 0) {
      footClass = "foot-dot bad";
      footText = `${health.available} up · ${health.unavailable} down`;
    } else {
      footClass = "foot-dot ok";
      footText = `${health.available} account${health.available === 1 ? "" : "s"} up`;
    }
  }

  return (
    <div className="app-shell">
      <Toasts />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l4 12 5-14 5 14 4-12" />
            </svg>
          </div>
          <div className="brand-text">
            <span className="brand-title">WANN X RENN</span>
            <span className="brand-sub">CLIProxyAPI</span>
          </div>
        </div>

        {typeof window !== "undefined" &&
          (window as unknown as { superApp?: { showHub?: () => void } }).superApp?.showHub && (
            <button
              type="button"
              className="super-back"
              onClick={() =>
                void (window as unknown as { superApp: { showHub: () => Promise<unknown> } }).superApp
                  .showHub()
              }
              title="Back to Super App hub"
              style={{
                margin: "0 12px 10px",
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.05)",
                color: "inherit",
                cursor: "pointer",
                fontSize: "0.82rem",
                textAlign: "left",
              }}
            >
              ← Super App
            </button>
          )}

        <nav className="side-nav">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? "active" : ""}
              onClick={() => setPage(p.id)}
              title={p.label}
            >
              <span className="ico">{ICONS[p.id]}</span>
              <span>{p.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot" title={footText}>
          <span className={footClass} />
          <span>{footText}</span>
        </div>
      </aside>

      <main className="app-main" key={page} data-page={page} aria-label={label}>
        {page === "overview" && <Overview onNavigate={(p) => isPageId(p) && setPage(p)} />}
        {page === "chat" && <Chat />}
        {page === "providers" && <Providers />}
        {page === "models" && <Models />}
        {page === "usage" && <Usage />}
        {page === "neuron" && <Neuron />}
        {page === "vscode" && <VsCode />}
        {page === "jetbrains" && <JetBrains />}
        {page === "logs" && <Logs />}
        {page === "config" && <Config />}
      </main>
    </div>
  );
}
