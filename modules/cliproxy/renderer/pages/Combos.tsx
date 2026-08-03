import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Save,
  Shuffle,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type ModelCombo,
  type ModelComboInput,
  type ModelComboStrategy,
  type ModelEntry,
} from "../api/client";
import { CommandSummary, PageHeader } from "../components/shared";
import { SkeletonRows, toast } from "../components/ui";

const EMPTY_FORM: ModelComboInput = {
  name: "",
  models: [],
  strategy: "fallback",
  stickyLimit: 1,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function Combos() {
  const [combos, setCombos] = useState<ModelCombo[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [form, setForm] = useState<ModelComboInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [comboResponse, modelResponse] = await Promise.all([api.getModelCombos(), api.getModels()]);
      setCombos(comboResponse.combos);
      setModels(modelResponse.models);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const realModels = useMemo(() => models.filter((model) => !model.combo), [models]);
  const modelById = useMemo(() => new Map(realModels.map((model) => [model.id, model])), [realModels]);
  const enabledIds = useMemo(() => new Set(models.filter((model) => model.enabled).map((model) => model.id)), [models]);
  const usedMembers = useMemo(() => new Set(combos.flatMap((combo) => combo.models)), [combos]);

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function edit(combo: ModelCombo) {
    setEditingId(combo.id);
    setForm({
      name: combo.name,
      models: [...combo.models],
      strategy: combo.strategy,
      stickyLimit: combo.stickyLimit,
    });
  }

  function addModel(modelId: string) {
    if (!modelId || form.models.includes(modelId)) return;
    setForm((current) => ({ ...current, models: [...current.models, modelId] }));
  }

  function removeModel(index: number) {
    setForm((current) => ({ ...current, models: current.models.filter((_, itemIndex) => itemIndex !== index) }));
  }

  function moveModel(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= form.models.length) return;
    setForm((current) => {
      const nextModels = [...current.models];
      [nextModels[index], nextModels[nextIndex]] = [nextModels[nextIndex], nextModels[index]];
      return { ...current, models: nextModels };
    });
  }

  async function save() {
    setSaving(true);
    try {
      if (editingId) await api.updateModelCombo(editingId, form);
      else await api.createModelCombo(form);
      toast.success(editingId ? "Combo updated" : "Combo created");
      resetForm();
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function remove(combo: ModelCombo) {
    if (!window.confirm(`Delete combo "${combo.name}"?`)) return;
    setDeletingId(combo.id);
    try {
      await api.deleteModelCombo(combo.id);
      if (editingId === combo.id) resetForm();
      toast.success("Combo deleted");
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDeletingId(null);
    }
  }

  async function setPublished(combo: ModelCombo, enabled: boolean) {
    setPublishingId(combo.id);
    try {
      const next = new Set(enabledIds);
      if (enabled) next.add(combo.name);
      else next.delete(combo.name);
      await api.setEnabledModels([...next]);
      setModels((current) => current.map((model) => model.id === combo.name ? { ...model, enabled } : model));
      toast.success(enabled ? "Combo published to editor integrations" : "Combo unpublished");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPublishingId(null);
    }
  }

  const availableToAdd = realModels.filter((model) => !form.models.includes(model.id));
  const roundRobinCount = combos.filter((combo) => combo.strategy === "round-robin").length;
  const publishedCount = combos.filter((combo) => enabledIds.has(combo.name)).length;

  return (
    <div className="page combos-page">
      <PageHeader
        eyebrow="SMART ROUTING"
        title="Model Combos"
        subtitle="Expose one virtual model name backed by an ordered chain of live CLIProxyAPI models."
        actions={
          <button className="btn secondary" type="button" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "combo-spin" : ""} />
            Refresh
          </button>
        }
      />

      <CommandSummary
        tone="cyan"
        icon={<GitBranch size={21} />}
        eyebrow="Routing layer"
        title={combos.length ? `${combos.length} virtual model${combos.length === 1 ? "" : "s"} configured` : "No routing chains configured"}
        description="Fallback tries members in priority order; round robin rotates the first attempt and still falls through on retryable errors."
        status={<span className={`command-status-pill ${combos.length ? "success" : "neutral"}`}><Route size={13} />{combos.length ? "Proxy aware" : "Ready to configure"}</span>}
        metrics={[
          { label: "combos", value: combos.length },
          { label: "published", value: publishedCount, tone: publishedCount ? "success" : "default" },
          { label: "round robin", value: roundRobinCount },
          { label: "models in chains", value: usedMembers.size },
        ]}
      />

      {loading ? <SkeletonRows rows={5} /> : (
        <div className="combo-workbench">
          <section className="combo-list-pane" aria-label="Configured model combos">
            <div className="combo-pane-head">
              <div>
                <span>Configured chains</span>
                <strong>{combos.length || "None yet"}</strong>
              </div>
              <button className="btn secondary" type="button" onClick={resetForm}>
                <Plus size={14} /> New
              </button>
            </div>

            {!combos.length && (
              <div className="combo-empty">
                <span><Layers3 size={22} /></span>
                <strong>Create your first Combo</strong>
                <p>Choose at least two live models and define their routing order.</p>
              </div>
            )}

            <div className="combo-cards">
              {combos.map((combo) => {
                const published = enabledIds.has(combo.name);
                return (
                  <article key={combo.id} className={`combo-card${editingId === combo.id ? " selected" : ""}`}>
                    <div className="combo-card-head">
                      <div className="combo-card-name">
                        <span className="combo-route-icon">{combo.strategy === "round-robin" ? <Shuffle size={16} /> : <GitBranch size={16} />}</span>
                        <div>
                          <strong>{combo.name}</strong>
                          <span>{combo.strategy === "round-robin" ? `Round robin · ${combo.stickyLimit} request${combo.stickyLimit === 1 ? "" : "s"}/model` : "Ordered fallback"}</span>
                        </div>
                      </div>
                      <span className={`badge ${published ? "success" : "neutral"}`}>{published ? "Published" : "Local only"}</span>
                    </div>

                    <ol className="combo-route-list">
                      {combo.models.map((modelId, index) => (
                        <li key={modelId}>
                          <span>{index + 1}</span>
                          <div><strong>{modelById.get(modelId)?.label || modelId}</strong><small>{modelId}</small></div>
                        </li>
                      ))}
                    </ol>

                    <div className="combo-card-actions">
                      <label className="combo-publish-toggle">
                        <input
                          className="toggle"
                          type="checkbox"
                          checked={published}
                          disabled={publishingId === combo.id}
                          onChange={(event) => void setPublished(combo, event.target.checked)}
                        />
                        <span>{published ? "Published" : "Publish"}</span>
                      </label>
                      <button className="icon-btn" type="button" title={`Edit ${combo.name}`} onClick={() => edit(combo)}><Pencil size={14} /></button>
                      <button className="icon-btn danger" type="button" title={`Delete ${combo.name}`} disabled={deletingId === combo.id} onClick={() => void remove(combo)}>
                        {deletingId === combo.id ? <LoaderCircle className="combo-spin" size={14} /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="combo-editor-pane" aria-label={editingId ? "Edit Combo" : "Create Combo"}>
            <div className="combo-editor-head">
              <span className="combo-editor-icon">{editingId ? <Pencil size={17} /> : <Plus size={17} />}</span>
              <div>
                <strong>{editingId ? "Edit routing chain" : "Create routing chain"}</strong>
                <span>{editingId ? "Changes preserve its published state." : "The Combo name becomes a selectable model id."}</span>
              </div>
            </div>

            <label className="combo-field">
              <span>Name</span>
              <input className="text-input" value={form.name} placeholder="production-coding" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
              <small>Letters, numbers, dots, hyphens, and underscores.</small>
            </label>

            <div className="combo-strategy-group">
              <span className="combo-field-label">Routing strategy</span>
              <div className="combo-strategy-options">
                <StrategyButton strategy="fallback" active={form.strategy === "fallback"} onSelect={(strategy) => setForm((current) => ({ ...current, strategy }))} />
                <StrategyButton strategy="round-robin" active={form.strategy === "round-robin"} onSelect={(strategy) => setForm((current) => ({ ...current, strategy }))} />
              </div>
            </div>

            {form.strategy === "round-robin" && (
              <label className="combo-field combo-sticky-field">
                <span>Sticky requests per model</span>
                <input className="text-input" type="number" min={1} max={100} value={form.stickyLimit} onChange={(event) => setForm((current) => ({ ...current, stickyLimit: Math.max(1, Number(event.target.value) || 1) }))} />
                <small>Rotate after this many requests; fallback still works inside each request.</small>
              </label>
            )}

            <div className="combo-builder">
              <div className="combo-builder-head">
                <div><span>Model chain</span><strong>{form.models.length} selected</strong></div>
                <select className="text-input" value="" onChange={(event) => addModel(event.target.value)} disabled={!availableToAdd.length}>
                  <option value="">{availableToAdd.length ? "Add live model..." : "No more models"}</option>
                  {availableToAdd.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </div>

              {!form.models.length && <div className="combo-builder-empty">Add models in the order they should be attempted.</div>}
              <ol className="combo-builder-list">
                {form.models.map((modelId, index) => (
                  <li key={modelId}>
                    <span className="combo-order-num">{index + 1}</span>
                    <div className="combo-builder-model"><strong>{modelById.get(modelId)?.label || modelId}</strong><small>{modelId}</small></div>
                    <div className="combo-order-actions">
                      <button type="button" title="Move up" disabled={index === 0} onClick={() => moveModel(index, -1)}><ArrowUp size={14} /></button>
                      <button type="button" title="Move down" disabled={index === form.models.length - 1} onClick={() => moveModel(index, 1)}><ArrowDown size={14} /></button>
                      <button type="button" title="Remove" onClick={() => removeModel(index)}><X size={14} /></button>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="combo-editor-actions">
              {editingId && <button className="btn secondary" type="button" onClick={resetForm}>Cancel</button>}
              <button className="btn" type="button" disabled={saving || !form.name.trim() || form.models.length < 2} onClick={() => void save()}>
                {saving ? <LoaderCircle className="combo-spin" size={15} /> : editingId ? <Save size={15} /> : <Check size={15} />}
                {saving ? "Saving" : editingId ? "Save changes" : "Create Combo"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StrategyButton({
  strategy,
  active,
  onSelect,
}: {
  strategy: ModelComboStrategy;
  active: boolean;
  onSelect: (strategy: ModelComboStrategy) => void;
}) {
  const roundRobin = strategy === "round-robin";
  return (
    <button type="button" className={`combo-strategy${active ? " active" : ""}`} onClick={() => onSelect(strategy)}>
      <span>{roundRobin ? <Shuffle size={17} /> : <GitBranch size={17} />}</span>
      <div><strong>{roundRobin ? "Round robin" : "Fallback"}</strong><small>{roundRobin ? "Rotate the primary model across requests" : "Always start from the first model"}</small></div>
      <i>{active && <Check size={13} />}</i>
    </button>
  );
}