import { useEffect, useState } from "react";
import type { WanAppSettings, WanVsCodeState } from "../wan";
import { PageHeader, CardHead, EmptyState } from "../components/shared";
import { toast } from "../components/ui";

const sv = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const IconCode = <svg {...sv}><path d="m9 8-5 4 5 4" /><path d="m15 8 5 4-5 4" /></svg>;
const IconTarget = <svg {...sv}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.6" /></svg>;
const IconSliders = <svg {...sv}><path d="M4 6h10" /><path d="M20 6h-2" /><circle cx="16" cy="6" r="2" /><path d="M4 18h4" /><path d="M14 18h6" /><circle cx="10" cy="18" r="2" /><path d="M4 12h2" /><path d="M12 12h8" /><circle cx="8" cy="12" r="2" /></svg>;

// Desktop-only page (handbook Tahap 5, item 5): VS Code detection, one-click
// sync / copy-key, and the app-level preferences that used to live in the
// extension's VS Code settings.
export function VsCode() {
  const [state, setState] = useState<WanVsCodeState | null>(null);
  const [settings, setSettings] = useState<WanAppSettings | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setState(await window.wan.vscodeState());
    setSettings(await window.wan.getSettings());
  }

  useEffect(() => {
    void refresh();
    const off = window.wan.onEvent((ev) => {
      if (ev.type === "sync" || ev.type === "sync-error") void refresh();
    });
    return off;
  }, []);

  async function doSync() {
    setBusy(true);
    const r = await window.wan.syncNow();
    setBusy(false);
    if (r.ok) {
      toast.success(
        r.changed
          ? `Synced ${r.modelCount} model(s) to ${r.targets.length} target(s).`
          : `Already up to date (${r.modelCount} model(s)).`
      );
    } else {
      toast.error(`Sync failed: ${r.error}`);
    }
    void refresh();
  }

  async function doCopyKey() {
    const r = await window.wan.copyApiKey();
    if (r.ok) toast.success("API key copied to clipboard.");
    else toast.error(`Couldn't copy key: ${r.error}`);
  }

  type BoolSetting = {
    [K in keyof WanAppSettings]: WanAppSettings[K] extends boolean ? K : never;
  }[keyof WanAppSettings];

  async function toggle(key: BoolSetting) {
    if (!settings) return;
    const next = await window.wan.setSetting(key, !settings[key]);
    setSettings(next);
  }

  const syncedCount = state?.variants.filter((v) => v.hasEntry).length ?? 0;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Integration"
        title="VS Code"
        subtitle="Push your enabled models into Copilot Chat automatically."
        actions={
          <>
            <button className="btn" onClick={doSync} disabled={busy}>
              {busy ? "Syncing…" : "Sync Now"}
            </button>
            <button className="btn secondary" onClick={doCopyKey}>
              Copy API Key
            </button>
          </>
        }
      />

      <div className="card accent">
        <CardHead
          icon={IconCode}
          title="How it works"
          subtitle="One-time manual step per new model"
          right={
            state?.targets.length ? (
              <span className="badge success">{syncedCount}/{state.targets.length} synced</span>
            ) : undefined
          }
        />
        <div className="card-desc">
          Writes the "WAN X RENN CLIProxyAPI" Custom Endpoint provider into each detected VS Code
          install's <code>chatLanguageModels.json</code>. After a new model appears you still need to
          reload VS Code once and paste the API key into "Chat: Manage Language Models".
        </div>
      </div>

      <div className="card">
        <CardHead icon={IconTarget} title="Detected targets" subtitle="VS Code / VSCodium installs on this machine" />
        {!state?.targets.length && (
          <EmptyState icon={IconCode}>No VS Code / VSCodium install detected.</EmptyState>
        )}
        {state?.variants.map((v) => (
          <div key={v.path} className="model-row">
            <span className="model-row-id">{v.path}</span>
            <span className={`badge ${v.hasEntry ? "success" : "neutral"}`}>
              {v.hasEntry ? "synced" : "not yet"}
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <CardHead icon={IconSliders} title="Preferences" subtitle="App behaviour & startup" />
        {settings &&
          (
            [
              ["autoStartServer", "Auto-start CLIProxyAPI on launch"],
              ["autoSyncVsCode", "Auto-sync models to VS Code"],
              ["requireApiKey", "Require proxy API key (off if VS Code never prompts for one)"],
              ["autoLaunch", "Launch at OS login"],
              ["startHidden", "Start hidden in the tray"],
            ] as [BoolSetting, string][]
          ).map(([key, label]) => (
            <div key={key} className="model-row">
              <span className="model-row-name">{label}</span>
              <input type="checkbox" className="toggle" checked={settings[key]} onChange={() => toggle(key)} />
            </div>
          ))}
      </div>
    </div>
  );
}
