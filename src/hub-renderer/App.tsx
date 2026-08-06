import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  Cloud,
  Download,
  ExternalLink,
  GitBranch,
  Network,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  Zap,
} from "lucide-react";
import type { ModuleId, SuperAppSettings, UpdateStatus } from "./wan";

const EMPTY_SETTINGS: SuperAppSettings = {
  lastModule: null,
  reopenLastModule: false,
  autoLaunch: false,
  startHidden: false,
  keepAliveWhenLeaving: true,
  openInNewWindow: true,
  theme: "aurora-dark",
};

const EMPTY_UPDATE: UpdateStatus = {
  phase: "idle",
  currentVersion: "…",
  availableVersion: null,
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  message: null,
  isPackaged: false,
  lastCheckedAt: null,
};

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

function phaseLabel(phase: UpdateStatus["phase"]): string {
  switch (phase) {
    case "checking":
      return "Checking";
    case "available":
      return "Update ready";
    case "not-available":
      return "Up to date";
    case "downloading":
      return "Downloading";
    case "downloaded":
      return "Ready to install";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

export function App() {
  const [settings, setSettings] = useState<SuperAppSettings>(EMPTY_SETTINGS);
  const [version, setVersion] = useState("…");
  const [opening, setOpening] = useState<ModuleId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus>(EMPTY_UPDATE);
  const [state, setState] = useState<{
    cliproxy: Record<string, unknown>;
    net: Record<string, unknown>;
    ssh: Record<string, unknown>;
    mindmap: Record<string, unknown>;
  }>({ cliproxy: {}, net: {}, ssh: {}, mindmap: {} });

  const refresh = useCallback(async () => {
    if (!window.superApp) return;
    try {
      const [s, v, m, u] = await Promise.all([
        window.superApp.getSettings(),
        window.superApp.getVersion(),
        window.superApp.moduleState(),
        window.superApp.getUpdateStatus(),
      ]);
      setSettings(s);
      setVersion(v);
      setState(m);
      setUpdate(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!window.superApp?.onUpdateStatus) return;
    return window.superApp.onUpdateStatus((status) => {
      setUpdate(status);
      if (status.currentVersion) setVersion(status.currentVersion);
    });
  }, []);

  async function openModule(id: ModuleId) {
    setError(null);
    setOpening(id);
    try {
      const res = await window.superApp.openModule(id);
      if (!res.ok) setError(res.error ?? "Failed to open module");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(null);
    }
  }

  async function toggle(key: keyof SuperAppSettings, value: boolean) {
    const next = await window.superApp.setSetting(key, value as never);
    setSettings(next);
  }

  async function runCheck() {
    setError(null);
    setUpdateBusy(true);
    try {
      const next = await window.superApp.checkForUpdates();
      setUpdate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function runDownload() {
    setError(null);
    setUpdateBusy(true);
    try {
      const next = await window.superApp.downloadUpdate();
      setUpdate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateBusy(false);
    }
  }

  async function runInstall() {
    setError(null);
    setUpdateBusy(true);
    try {
      const res = await window.superApp.installUpdate();
      if (!res.ok) setError(res.error ?? "Install update gagal");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateBusy(false);
    }
  }

  const clipRunning = !!state.cliproxy.running;
  const netRunning = !!state.net.running;
  const tunnels = Number(state.net.liveTunnels ?? state.net.tunnels ?? 0);
  const sshRunning = !!state.ssh.running;
  const sshVault = String(state.ssh.vault ?? "");
  const mindmapRunning = !!state.mindmap.running;
  const mindmapCloud = !!state.mindmap.cloud;

  const updateHint = useMemo(() => {
    if (update.message) return update.message;
    if (update.phase === "idle") {
      return update.isPackaged
        ? "Cek GitHub Releases untuk versi baru Super App."
        : "Mode development — install update hanya di build production.";
    }
    return "";
  }, [update]);

  const lastChecked =
    update.lastCheckedAt != null
      ? new Date(update.lastCheckedAt).toLocaleString()
      : null;

  const showProgress = update.phase === "downloading" || update.phase === "downloaded";
  const progressPct = Math.max(0, Math.min(100, update.percent || 0));
  const runningModules = [clipRunning, netRunning, sshRunning, mindmapRunning].filter(Boolean).length;

  return (
    <main className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <div className="app">
        <header className="header">
          <div className="brand-row">
            <div className="brand-mark" aria-hidden="true"><span>W</span></div>
            <div className="brand-copy">
              <h1>WAN</h1>
              <span>SUPER APP</span>
            </div>
          </div>
          <div className="header-status">
            <span className="system-live"><i /> SYSTEM ONLINE</span>
            <span className="version">v{version}</span>
          </div>
        </header>

        <section className="hero-band">
          <div className="hero-copy">
            <span className="eyebrow"><Zap size={13} /> WAN COMMAND CENTER</span>
            <h2>Everything you need.<br /><em>One powerful workspace.</em></h2>
            <p>Kelola AI workspace, secure networking, dan remote infrastructure dari satu pusat kendali.</p>
          </div>
          <div className="system-summary">
            <div><span>ACTIVE MODULES</span><strong>{runningModules}<small>/04</small></strong></div>
            <div><span>NETWORK</span><strong>{tunnels > 0 ? `${tunnels} LIVE` : "STANDBY"}</strong></div>
            <div><span>SECURITY</span><strong><ShieldCheck size={15} /> SECURED</strong></div>
          </div>
        </section>

        <div className="section-heading">
          <div><span className="section-index">01</span><h3>Workspace modules</h3></div>
          <p>Select a module to begin</p>
        </div>

        <div className="module-grid">
          <article className="module-card module-ai">
            <div className="module-topline"><span>AI / AUTOMATION</span><Activity size={16} /></div>
            <div className="module-icon"><Bot size={28} /></div>
            <div className="module-title"><h4>WANN X RENN</h4><span>CLIProxyAPI</span></div>
            <p>Advanced AI chat, Cowork Mode, Neuron Activity, and native IDE integration.</p>
            <div className="module-meta">
              <span className={`status ${clipRunning ? "online" : "idle"}`}><i />{clipRunning ? "Running" : "Ready"}</span>
              {state.cliproxy.port != null && <span className="mono">:{String(state.cliproxy.port)}</span>}
            </div>
            <button className="module-action" disabled={opening === "cliproxy"} onClick={() => void openModule("cliproxy")}>
              <span>{opening === "cliproxy" ? "Opening..." : "Launch workspace"}</span><ArrowUpRight size={17} />
            </button>
          </article>

          <article className="module-card module-net">
            <div className="module-topline"><span>EDGE / NETWORK</span><Cloud size={16} /></div>
            <div className="module-icon"><Network size={28} /></div>
            <div className="module-title"><h4>WAN NET</h4><span>Secure Tunnel</span></div>
            <p>Cloudflare quick tunnels, multi-endpoint routing, live inspector, logs, and QR sharing.</p>
            <div className="module-meta">
              <span className={`status ${netRunning ? "online" : "idle"}`}><i />{netRunning ? "Running" : "Ready"}</span>
              {tunnels > 0 && <span className="mono">{tunnels} tunnel{tunnels === 1 ? "" : "s"}</span>}
            </div>
            <button className="module-action" disabled={opening === "net"} onClick={() => void openModule("net")}>
              <span>{opening === "net" ? "Opening..." : "Open network"}</span><ArrowUpRight size={17} />
            </button>
          </article>

          <article className="module-card module-ssh">
            <div className="module-topline"><span>REMOTE / TERMINAL</span><ShieldCheck size={16} /></div>
            <div className="module-icon"><Terminal size={28} /></div>
            <div className="module-title"><h4>WANN SSH</h4><span>Secure Shell</span></div>
            <p>Encrypted SSH vault, verified host keys, full terminal, and optional cloud synchronization.</p>
            <div className="module-meta">
              <span className={`status ${sshRunning ? "online" : "idle"}`}><i />{sshRunning ? "Running" : "Ready"}</span>
              {sshVault && <span className="mono">{sshVault}</span>}
            </div>
            <button className="module-action" disabled={opening === "ssh"} onClick={() => void openModule("ssh")}>
              <span>{opening === "ssh" ? "Opening..." : "Open terminal"}</span><ArrowUpRight size={17} />
            </button>
          </article>

          <article className="module-card module-mindmap">
            <div className="module-topline"><span>KNOWLEDGE / VISUAL</span><GitBranch size={16} /></div>
            <div className="module-icon"><GitBranch size={28} /></div>
            <div className="module-title"><h4>WAN MINDMAP</h4><span>Case Flow</span></div>
            <p>Visual strategy workspace with structured canvases, offline recovery, and Firebase synchronization.</p>
            <div className="module-meta">
              <span className={`status ${mindmapRunning ? "online" : "idle"}`}><i />{mindmapRunning ? "Running" : "Ready"}</span>
              <span className="mono">{mindmapCloud ? "Firebase" : "Local"}</span>
            </div>
            <button className="module-action" disabled={opening === "mindmap"} onClick={() => void openModule("mindmap")}>
              <span>{opening === "mindmap" ? "Opening..." : "Open mindmap"}</span><ArrowUpRight size={17} />
            </button>
          </article>
        </div>

        {error && <div className="error" role="alert">{error}</div>}

        <div className="dashboard-grid">
          <section className={`update-card phase-${update.phase}`}>
            <div className="panel-heading">
              <div className="panel-icon"><Download size={18} /></div>
              <div><span>SYSTEM</span><h3>Software update</h3></div>
              <span className={`update-state phase-${update.phase}`}><i />{phaseLabel(update.phase)}</span>
            </div>

            <div className="update-versions">
              <div><span>INSTALLED</span><strong>v{update.currentVersion || version}</strong></div>
              <ArrowUpRight size={18} />
              <div><span>LATEST</span><strong>{update.availableVersion ? `v${update.availableVersion}` : "Current"}</strong></div>
            </div>

            <p className="update-message">{updateHint}</p>

            {showProgress && (
              <div className="update-progress">
                <div className="progress-label"><span>Download progress</span><strong>{Math.round(progressPct)}%</strong></div>
                <div className="bar"><div className="fill" style={{ width: `${progressPct}%` }} /></div>
                {update.phase === "downloading" && <span className="transfer-rate">
                  {formatBytes(update.transferred)}{update.total > 0 ? ` / ${formatBytes(update.total)}` : ""}{update.bytesPerSecond > 0 ? ` · ${formatSpeed(update.bytesPerSecond)}` : ""}
                </span>}
              </div>
            )}

            <div className="update-footer">
              <span>Last check: {lastChecked ?? "Not checked"}</span>
              <div className="update-actions">
                <button className="icon-button" title="Check for updates" aria-label="Check for updates" disabled={updateBusy || update.phase === "checking" || update.phase === "downloading"} onClick={() => void runCheck()}>
                  <RefreshCw size={17} className={update.phase === "checking" ? "spin" : ""} />
                </button>
                {(update.phase === "available" || (update.phase === "error" && !!update.availableVersion)) && <button disabled={updateBusy} onClick={() => void runDownload()}><Download size={16} />Download</button>}
                {update.phase === "downloading" && <button disabled><Download size={16} />Downloading</button>}
                {update.phase === "downloaded" && <button disabled={updateBusy} onClick={() => void runInstall()}><Check size={16} />Restart &amp; install</button>}
              </div>
            </div>
          </section>

          <section className="settings">
            <div className="panel-heading">
              <div className="panel-icon"><Settings2 size={18} /></div>
              <div><span>CONTROL</span><h3>Preferences</h3></div>
            </div>
            <div className="settings-list">
              <label className="setting-row">
                <div><ExternalLink size={16} /><span>Open in new window<small>Dedicated window for every module</small></span></div>
                <input type="checkbox" checked={settings.openInNewWindow} onChange={(event) => void toggle("openInNewWindow", event.target.checked)} />
              </label>
              <label className="setting-row">
                <div><RefreshCw size={16} /><span>Restore last module<small>Continue where you left off</small></span></div>
                <input type="checkbox" checked={settings.reopenLastModule} disabled={!settings.openInNewWindow} onChange={(event) => void toggle("reopenLastModule", event.target.checked)} />
              </label>
              <label className="setting-row">
                <div><Activity size={16} /><span>Keep modules active<small>Keep backends running in Hub</small></span></div>
                <input type="checkbox" checked={settings.keepAliveWhenLeaving} onChange={(event) => void toggle("keepAliveWhenLeaving", event.target.checked)} />
              </label>
              <label className="setting-row">
                <div><Zap size={16} /><span>Launch at login<small>Start automatically with macOS</small></span></div>
                <input type="checkbox" checked={settings.autoLaunch} onChange={(event) => void toggle("autoLaunch", event.target.checked)} />
              </label>
              <label className="setting-row">
                <div><ShieldCheck size={16} /><span>Start hidden<small>Launch directly into the tray</small></span></div>
                <input type="checkbox" checked={settings.startHidden} disabled={!settings.autoLaunch} onChange={(event) => void toggle("startHidden", event.target.checked)} />
              </label>
            </div>
          </section>
        </div>

        <footer><span>WAN SUPER APP</span><span>Built for secure operations</span></footer>
      </div>
    </main>
  );
}
