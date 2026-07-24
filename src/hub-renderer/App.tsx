import { useCallback, useEffect, useMemo, useState } from "react";
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
  }>({ cliproxy: {}, net: {} });

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

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>WAN Super App</h1>
          <p>Pilih modul App.</p>
        </div>
        <div className="version">v{version}</div>
      </header>

      <div className="grid">
        <section className="card clip">
          <h2>WANN X RENN CLIProxyAPI</h2>
          <p className="desc">
            Chat AI, Cowork Mode, Neuron Activity, VS Code &amp; JetBrains integration.
            Backend Express + CLIProxyAPI.
          </p>
          <div className="pills">
            <span className={`pill ${clipRunning ? "on" : "off"}`}>
              {clipRunning ? "Running" : "Idle"}
            </span>
            {state.cliproxy.port != null && (
              <span className="pill">port {String(state.cliproxy.port)}</span>
            )}
          </div>
          <div className="actions">
            <button disabled={opening === "cliproxy"} onClick={() => void openModule("cliproxy")}>
              {opening === "cliproxy" ? "Opening…" : "Buka CLIProxyAPI"}
            </button>
          </div>
        </section>

        <section className="card net">
          <h2>WAN NET</h2>
          <p className="desc">
            Cloudflare Quick Tunnel, multi-tunnel, Inspector, log &amp; QR. Cloudflared
            built-in.
          </p>
          <div className="pills">
            <span className={`pill ${netRunning ? "on" : "off"}`}>
              {netRunning ? "Running" : "Idle"}
            </span>
            {tunnels > 0 && <span className="pill on">{tunnels} tunnel(s)</span>}
          </div>
          <div className="actions">
            <button disabled={opening === "net"} onClick={() => void openModule("net")}>
              {opening === "net" ? "Opening…" : "Buka WAN NET"}
            </button>
          </div>
        </section>
      </div>

      {error && <div className="error">{error}</div>}

      <section className={`update-card phase-${update.phase}`}>
        <div className="update-head">
          <div>
            <h3>App Update</h3>
            <p className="update-sub">
              Sumber: GitHub Releases ·{" "}
              <code>setiyawan12/WAN-SUPER-APP</code>
            </p>
          </div>
          <span className={`pill update-pill phase-${update.phase}`}>
            {phaseLabel(update.phase)}
          </span>
        </div>

        <div className="update-meta">
          <div>
            <span className="muted">Installed</span>
            <strong>v{update.currentVersion || version}</strong>
          </div>
          <div>
            <span className="muted">Latest</span>
            <strong>
              {update.availableVersion ? `v${update.availableVersion}` : "—"}
            </strong>
          </div>
          <div>
            <span className="muted">Last check</span>
            <strong>{lastChecked ?? "Belum"}</strong>
          </div>
        </div>

        <p className="update-msg">{updateHint}</p>

        {showProgress && (
          <div className="update-progress">
            <div className="bar">
              <div className="fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="progress-meta">
              <span>{Math.round(progressPct)}%</span>
              {update.phase === "downloading" && (
                <span>
                  {formatBytes(update.transferred)}
                  {update.total > 0 ? ` / ${formatBytes(update.total)}` : ""}
                  {update.bytesPerSecond > 0
                    ? ` · ${formatSpeed(update.bytesPerSecond)}`
                    : ""}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="actions update-actions">
          <button
            className="secondary"
            disabled={
              updateBusy ||
              update.phase === "checking" ||
              update.phase === "downloading"
            }
            onClick={() => void runCheck()}
          >
            {update.phase === "checking" ? "Checking…" : "Check for updates"}
          </button>

          {(update.phase === "available" ||
            (update.phase === "error" && !!update.availableVersion)) && (
            <button disabled={updateBusy} onClick={() => void runDownload()}>
              {updateBusy && update.phase !== "available"
                ? "Starting…"
                : `Download v${update.availableVersion}`}
            </button>
          )}

          {update.phase === "downloading" && (
            <button disabled>Downloading…</button>
          )}

          {update.phase === "downloaded" && (
            <button disabled={updateBusy} onClick={() => void runInstall()}>
              Restart &amp; install
            </button>
          )}
        </div>
      </section>

      <section className="settings">
        <h3>Preferences</h3>
        <div className="row">
          <label>
            <span>Open modules in new window</span>
            <small>
              On: tiap modul buka window sendiri (default). Off: ganti halaman Hub
              dengan UI modul.
            </small>
          </label>
          <input
            type="checkbox"
            checked={settings.openInNewWindow}
            onChange={(e) => void toggle("openInNewWindow", e.target.checked)}
          />
        </div>
        <div className="row">
          <label>
            <span>Reopen last module on launch</span>
            <small>
              Hanya jika &quot;Open modules in new window&quot; aktif: buka modul
              terakhir di window terpisah, Hub tetap jadi halaman utama.
            </small>
          </label>
          <input
            type="checkbox"
            checked={settings.reopenLastModule}
            disabled={!settings.openInNewWindow}
            onChange={(e) => void toggle("reopenLastModule", e.target.checked)}
          />
        </div>
        <div className="row">
          <label>
            <span>Keep module alive when leaving</span>
            <small>Jangan matikan backend saat kembali ke Hub</small>
          </label>
          <input
            type="checkbox"
            checked={settings.keepAliveWhenLeaving}
            onChange={(e) => void toggle("keepAliveWhenLeaving", e.target.checked)}
          />
        </div>
        <div className="row">
          <label>
            <span>Launch at login</span>
            <small>Start Super App saat login OS</small>
          </label>
          <input
            type="checkbox"
            checked={settings.autoLaunch}
            onChange={(e) => void toggle("autoLaunch", e.target.checked)}
          />
        </div>
        <div className="row">
          <label>
            <span>Start hidden</span>
            <small>Hanya tray jika launch at login</small>
          </label>
          <input
            type="checkbox"
            checked={settings.startHidden}
            onChange={(e) => void toggle("startHidden", e.target.checked)}
          />
        </div>
      </section>
    </div>
  );
}
