import { useEffect, useState } from "react";
import { CheckCircle2, CircleHelp, Eye, EyeOff, Info, Layers3, Power, PowerOff, RefreshCw, Search, Sparkles } from "lucide-react";
import { api, type ModelEntry } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { loadCustomGroups } from "../lib/custom-groups";
import { CommandSummary, PageHeader } from "../components/shared";
import { SkeletonRows } from "../components/ui";

const PINNED_PROVIDERS = ["antigravity", "claude", "codex", "xai"];
const PROVIDER_LABELS: Record<string, string> = {
  antigravity: "Antigravity",
  claude: "Claude",
  codex: "Codex",
  xai: "xAI (Grok)",
  combo: "Combos",
  other: "Other",
};

function groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

export function Models() {
  const { data, mutate, isLoading } = usePolling(api.getModels, 15000);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [query, setQuery] = useState("");
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  // Custom-provider grouping is set on the Providers page and stored in
  // localStorage (never sent to the backend) -- read it here too so a model
  // served by e.g. a "tokenrouter" custom provider shows under that label.
  const [customGroups, setCustomGroups] = useState<Record<string, string>>({});

  useEffect(() => {
    setCustomGroups(loadCustomGroups());
  }, []);

  function labelFor(provider: string): string {
    return PROVIDER_LABELS[provider] ?? customGroups[provider] ?? provider;
  }

  const models = data?.models ?? [];

  async function changeThinkingLevel(model: ModelEntry, level: string) {
    // Optimistically reflect the pick, then persist. On failure, a refetch
    // (mutate undefined) snaps the row back to the server's truth.
    mutate(
      (current) =>
        current && {
          ...current,
          models: current.models.map((m) => (m.id === model.id ? { ...m, thinkingLevel: level } : m)),
        },
      false
    );
    try {
      await api.setThinkingLevel(model.id, level);
    } catch {
      mutate(undefined, true);
    }
  }

  async function verifyModel(model: ModelEntry) {
    setVerifying((v) => ({ ...v, [model.id]: true }));
    try {
      const result = await api.verifyVision(model.id);
      mutate(
        (current) =>
          current && {
            ...current,
            models: current.models.map((m) =>
              m.id === model.id ? { ...m, capabilities: { vision: result.vision, note: result.note, checkedAt: Date.now() } } : m
            ),
          },
        false
      );
    } catch (err) {
      mutate(
        (current) =>
          current && {
            ...current,
            models: current.models.map((m) => (m.id === model.id ? { ...m, capabilities: { ...m.capabilities, note: (err as Error).message } } : m)),
          },
        false
      );
    } finally {
      setVerifying((v) => ({ ...v, [model.id]: false }));
    }
  }

  const presentProviders = new Set(models.map((m) => m.provider));
  const tabs = [
    "all",
    ...PINNED_PROVIDERS.filter((p) => presentProviders.has(p)),
    ...Array.from(presentProviders).filter((p) => !PINNED_PROVIDERS.includes(p)),
  ];

  const tabModels = activeTab === "all" ? models : models.filter((m) => m.provider === activeTab);
  const q = query.trim().toLowerCase();
  const visibleModels = q ? tabModels.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : tabModels;
  const grouped = groupBy(visibleModels, (m) => m.provider);

  async function applyEnabledIds(nextIds: string[]) {
    const nextIdSet = new Set(nextIds);
    mutate(
      {
        models: models.map((m) => ({ ...m, enabled: nextIdSet.has(m.id) })),
        source: data?.source ?? "live",
        liveError: data?.liveError ?? null,
      },
      false
    );
    setSaving(true);
    try {
      await api.setEnabledModels(nextIds);
    } finally {
      setSaving(false);
      mutate(undefined, true);
    }
  }

  function toggle(model: ModelEntry, enabled: boolean) {
    const nextIds = enabled ? [...models.filter((m) => m.enabled).map((m) => m.id), model.id] : models.filter((m) => m.enabled && m.id !== model.id).map((m) => m.id);
    return applyEnabledIds(nextIds);
  }

  function setGroupEnabled(items: ModelEntry[], enabled: boolean) {
    const groupIds = new Set(items.map((m) => m.id));
    const others = models.filter((m) => !groupIds.has(m.id) && m.enabled).map((m) => m.id);
    const nextIds = enabled ? [...others, ...items.map((m) => m.id)] : others;
    return applyEnabledIds(nextIds);
  }

  function setAllEnabled(enabled: boolean) {
    return applyEnabledIds(enabled ? models.map((m) => m.id) : []);
  }

  const enabledTotal = models.filter((model) => model.enabled).length;
  const providerCount = presentProviders.size;
  const thinkingCount = models.filter((model) => model.thinking).length;
  const visionCount = models.filter((model) => model.capabilities.vision === true).length;

  return (
    <div className="page models-page">
      <PageHeader
        eyebrow="BYOK"
        title="Models"
        subtitle="Control the model catalog synced into Copilot Chat and connected editors."
        actions={
          <>
            {saving && <span className="badge neutral">Saving…</span>}
            <button className="btn secondary" disabled={!models.length} onClick={() => setAllEnabled(false)}>
              <PowerOff size={15} />
              Disable all
            </button>
            <button className="btn" disabled={!models.length} onClick={() => setAllEnabled(true)}>
              <Power size={15} />
              Enable all
            </button>
          </>
        }
      />

      <CommandSummary
        tone="blue"
        icon={<Layers3 size={21} />}
        eyebrow="Model registry"
        title={models.length ? `${enabledTotal} models ready to route` : "Waiting for the live catalog"}
        description="Enabled entries are published to local editor integrations; capability checks remain model-specific."
        status={
          <span className={`command-status-pill ${data?.source === "live" ? "success" : "neutral"}`}>
            {data?.source === "live" ? <CheckCircle2 size={13} /> : <CircleHelp size={13} />}
            {data?.source === "live" ? "Live catalog" : "Catalog unavailable"}
          </span>
        }
        metrics={[
          { label: "enabled", value: enabledTotal, tone: enabledTotal ? "success" : "default" },
          { label: "available", value: models.length },
          { label: "providers", value: providerCount },
          { label: "thinking", value: thinkingCount },
          { label: "vision verified", value: visionCount },
        ]}
      />

      <div className="models-toolbar">
        <div className="models-tabs" role="tablist" aria-label="Model provider">
          {tabs.map((tab) => {
            const count = tab === "all" ? models.length : models.filter((m) => m.provider === tab).length;
            return (
              <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} onClick={() => setActiveTab(tab)}>
                {tab === "all" ? "All" : labelFor(tab)} <span>{count}</span>
              </button>
            );
          })}
        </div>
        {models.length > 0 && (
          <label className="models-search">
            <Search size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models..." />
          </label>
        )}
      </div>

      {isLoading && <SkeletonRows rows={6} />}

      {!isLoading && !visibleModels.length && <p className="page-hint">{q ? "No models match your search." : "No models for this provider yet."}</p>}

      {!isLoading && data?.source === "empty" && (
        <div className="empty-hint">
          Couldn't fetch the live model list from CLIProxyAPI ({data.liveError || "is the server running and is at least one account logged in?"}). Start
          the server and log in to a provider, then this list will populate automatically.
        </div>
      )}

      {Object.entries(grouped).map(([provider, items]) => {
        const enabledCount = items.filter((m) => m.enabled).length;
        return (
          <section className="card models-provider-card" key={provider}>
            <div className="models-group-head">
              <div className="models-group-identity">
                <span className="models-group-icon"><Sparkles size={17} /></span>
                <div>
                  <strong>{labelFor(provider)}</strong>
                  <span>{enabledCount}/{items.length} models enabled</span>
                </div>
              </div>
              <div className="btn-row">
                <button className="btn secondary" disabled={enabledCount === 0} onClick={() => setGroupEnabled(items, false)}>
                  Disable all
                </button>
                <button className="btn secondary" disabled={enabledCount === items.length} onClick={() => setGroupEnabled(items, true)}>
                  Enable all
                </button>
              </div>
            </div>
            <div className="models-group-progress"><span style={{ width: `${items.length ? (enabledCount / items.length) * 100 : 0}%` }} /></div>
            <div className="models-list">
              <div className="models-list-head" aria-hidden="true">
                <span>Model</span>
                <span>Reasoning</span>
                <span>Capability</span>
                <span>Enabled</span>
              </div>
              {items.map((m) => (
                <div className={`model-row ${m.enabled ? "enabled" : ""}`} key={m.id}>
                  <div className="model-row-copy">
                    <div className="model-row-name">{m.label}</div>
                    <div className="model-row-id">
                      {m.id} {m.thinking && "· thinking"}
                    </div>
                  </div>
                  <div className="model-control-cell model-reasoning-cell">
                    <span className="model-control-label">Reasoning</span>
                    {m.thinkingLevels?.length ? (
                      <select
                        className="text-input model-thinking-select"
                        title="Reasoning effort sent for this model (Default = provider's own default)"
                        value={m.thinkingLevel || ""}
                        onChange={(e) => changeThinkingLevel(m, e.target.value)}
                      >
                        <option value="">Default</option>
                        {m.thinkingLevels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="model-control-muted">Standard</span>
                    )}
                  </div>
                  <div className="model-control-cell model-capability-cell">
                    <span className="model-control-label">Capability</span>
                    <CapabilityBadge capabilities={m.capabilities} derived={!!m.combo} verifying={!!verifying[m.id]} onRecheck={() => verifyModel(m)} />
                  </div>
                  <label className="model-toggle-cell">
                    <span className="model-control-label">Enabled</span>
                    <span className="model-toggle-control">
                      <span>{m.enabled ? "On" : "Off"}</span>
                      <input
                        type="checkbox"
                        className="toggle"
                        checked={m.enabled}
                        aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.label}`}
                        onChange={(e) => toggle(m, e.target.checked)}
                      />
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <div className="empty-hint models-sync-note">
        <Info size={17} />
        <span>
        After changing models here, reload VS Code and enable them via Copilot Chat's model picker → "Manage Models..." → click the eye icon. That last
        step has to be manual -- VS Code doesn't expose an API to enable BYOK models programmatically yet.
        </span>
      </div>
    </div>
  );
}

function CapabilityBadge({
  capabilities,
  derived,
  verifying,
  onRecheck,
}: {
  capabilities: { vision: boolean | "unknown"; note?: string };
  derived?: boolean;
  verifying: boolean;
  onRecheck: () => void;
}) {
  const { vision, note } = capabilities;
  const badge =
    vision === true ? (
      <span className="badge success" title={note}>
        <Eye size={12} />
        Vision
      </span>
    ) : vision === false ? (
      <span className="badge error" title={note}>
        <EyeOff size={12} />
        No vision
      </span>
    ) : (
      <span className="badge neutral" title={note || "Not verified yet"}>
        <CircleHelp size={12} />
        Unverified
      </span>
    );

  return (
    <div className="model-capability">
      {badge}
      {derived ? (
        <span className="badge neutral" title="Derived from Combo member capabilities">Derived</span>
      ) : (
        <button className="icon-recheck" title="Re-check vision support (sends one real test request)" disabled={verifying} onClick={onRecheck}>
          <RefreshCw className={verifying ? "model-rechecking" : ""} size={14} />
        </button>
      )}
    </div>
  );
}
