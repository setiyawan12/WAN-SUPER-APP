import { useCallback, useEffect, useState } from "react";
import type { ModuleId, SuperAppSettings } from "./wan";

const EMPTY_SETTINGS: SuperAppSettings = {
  lastModule: null,
  reopenLastModule: false,
  autoLaunch: false,
  startHidden: false,
  keepAliveWhenLeaving: true,
  openInNewWindow: true,
  theme: "aurora-dark",
};

export function App() {
  const [settings, setSettings] = useState<SuperAppSettings>(EMPTY_SETTINGS);
  const [version, setVersion] = useState("…");
  const [opening, setOpening] = useState<ModuleId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<{
    cliproxy: Record<string, unknown>;
    net: Record<string, unknown>;
  }>({ cliproxy: {}, net: {} });

  const refresh = useCallback(async () => {
    if (!window.superApp) return;
    try {
      const [s, v, m] = await Promise.all([
        window.superApp.getSettings(),
        window.superApp.getVersion(),
        window.superApp.moduleState(),
      ]);
      setSettings(s);
      setVersion(v);
      setState(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

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

  const clipRunning = !!state.cliproxy.running;
  const netRunning = !!state.net.running;
  const tunnels = Number(state.net.liveTunnels ?? state.net.tunnels ?? 0);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <h1>WAN Super App</h1>
          <p>Pilih modul — desain &amp; fungsi sama seperti app aslinya.</p>
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
            <small>Buka modul terakhir saat Super App start</small>
          </label>
          <input
            type="checkbox"
            checked={settings.reopenLastModule}
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
