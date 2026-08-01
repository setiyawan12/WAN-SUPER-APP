import { useEffect, useState } from "react";
import { CheckCircle2, Clipboard, Code2, FileJson2, RefreshCw, Settings2, ShieldCheck, Target, WandSparkles } from "lucide-react";
import type { WanAppSettings, WanVsCodeState } from "../wan";
import { PageHeader, CardHead, CommandSummary, EmptyState } from "../components/shared";
import { toast } from "../components/ui";

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
  const targetCount = state?.targets.length ?? 0;
  const pendingCount = Math.max(0, targetCount - syncedCount);

  return (
    <div className="page ide-page vscode-page">
      <PageHeader
        eyebrow="Integration"
        title="VS Code"
        subtitle="Deploy the local model catalog into VS Code and VSCodium Copilot Chat."
        actions={
          <>
            <button className="btn" onClick={doSync} disabled={busy}>
              <RefreshCw className={busy ? "ide-sync-spin" : ""} size={15} />
              {busy ? "Syncing…" : "Sync Now"}
            </button>
            <button className="btn secondary" onClick={doCopyKey}>
              <Clipboard size={15} />
              Copy API Key
            </button>
          </>
        }
      />

      <CommandSummary
        tone="blue"
        icon={<Code2 size={21} />}
        eyebrow="Editor deployment"
        title={targetCount ? `${syncedCount} of ${targetCount} targets configured` : "No editor target detected"}
        description="Sync writes a managed Custom Endpoint entry into each detected editor profile; your enabled model list stays the source of truth."
        status={
          <span className={`command-status-pill ${targetCount > 0 && pendingCount === 0 ? "success" : "neutral"}`}>
            {targetCount > 0 && pendingCount === 0 ? <CheckCircle2 size={13} /> : <Target size={13} />}
            {targetCount === 0 ? "Awaiting editor" : pendingCount === 0 ? "All targets synced" : `${pendingCount} pending`}
          </span>
        }
        metrics={[
          { label: "detected", value: targetCount },
          { label: "synced", value: syncedCount, tone: syncedCount ? "success" : "default" },
          { label: "pending", value: pendingCount, tone: pendingCount ? "warn" : "default" },
          { label: "auto-sync", value: settings?.autoSyncVsCode ? "On" : "Off", tone: settings?.autoSyncVsCode ? "success" : "default" },
        ]}
      />

      <div className="card accent ide-flow-card">
        <CardHead
          icon={<WandSparkles size={18} />}
          title="Deployment flow"
          subtitle="Managed configuration with one editor-side approval"
          right={
            state?.targets.length ? (
              <span className="badge success">{syncedCount}/{state.targets.length} synced</span>
            ) : undefined
          }
        />
        <div className="ide-flow-steps">
          <div><span>1</span><div><strong>Publish catalog</strong><small>Enabled models become the editor model list.</small></div></div>
          <div><span>2</span><div><strong>Write endpoint</strong><small>Each detected <code>chatLanguageModels.json</code> is updated.</small></div></div>
          <div><span>3</span><div><strong>Approve once</strong><small>Reload the editor and paste the API key for new models.</small></div></div>
        </div>
      </div>

      <div className="card ide-targets-card">
        <CardHead icon={<Target size={18} />} title="Detected targets" subtitle="VS Code and VSCodium profiles on this machine" />
        {!state?.targets.length && (
          <EmptyState icon={<Code2 size={18} />}>No VS Code / VSCodium install detected.</EmptyState>
        )}
        {state?.variants.map((v) => (
          <div key={v.path} className={`ide-target-row ${v.hasEntry ? "synced" : "pending"}`}>
            <span className="ide-target-icon"><FileJson2 size={17} /></span>
            <div>
              <strong>{v.path.split(/[\\/]/).slice(-2).join("/")}</strong>
              <span>{v.path}</span>
            </div>
            <span className={`badge ${v.hasEntry ? "success" : "neutral"}`}>
              {v.hasEntry ? <CheckCircle2 size={12} /> : <Target size={12} />}
              {v.hasEntry ? "Synced" : "Pending"}
            </span>
          </div>
        ))}
      </div>

      <div className="card ide-preferences-card">
        <CardHead icon={<Settings2 size={18} />} title="Preferences" subtitle="Gateway, sync, and startup behavior" />
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
            <label key={key} className="ide-setting-row">
              <span className="ide-setting-icon">{key === "requireApiKey" ? <ShieldCheck size={16} /> : <Settings2 size={16} />}</span>
              <span>{label}</span>
              <input type="checkbox" className="toggle" checked={settings[key]} onChange={() => toggle(key)} />
            </label>
          ))}
      </div>
    </div>
  );
}
