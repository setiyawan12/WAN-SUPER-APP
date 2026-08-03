import { randomUUID } from "node:crypto";
import { readState, writeState } from "./state.js";
import { prioritizeModelsByBudget } from "./quota-budget.js";

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;
const STRATEGIES = new Set(["fallback", "round-robin"]);
const rotationState = new Map();

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return [...new Set(models.map((model) => String(model || "").trim()).filter(Boolean))];
}

function normalizeCombo(raw, existingId = "") {
  const name = String(raw?.name || "").trim();
  const models = normalizeModels(raw?.models);
  const strategy = STRATEGIES.has(raw?.strategy) ? raw.strategy : "fallback";
  const stickyLimit = Math.max(1, Number.parseInt(raw?.stickyLimit, 10) || 1);

  if (!name) throw Object.assign(new Error("Combo name is required."), { status: 400, expected: true });
  if (!VALID_NAME.test(name)) {
    throw Object.assign(new Error("Combo name may only contain letters, numbers, dots, hyphens, and underscores."), { status: 400, expected: true });
  }
  if (models.length < 2) {
    throw Object.assign(new Error("A combo requires at least two distinct models."), { status: 400, expected: true });
  }
  if (models.includes(name)) {
    throw Object.assign(new Error("A combo cannot contain itself."), { status: 400, expected: true });
  }
  const comboNames = new Set(listModelCombos().filter((combo) => combo.id !== existingId).map((combo) => combo.name));
  const nested = models.find((model) => comboNames.has(model));
  if (nested) {
    throw Object.assign(new Error(`Nested combo "${nested}" is not supported.`), { status: 400, expected: true });
  }

  return {
    id: existingId || randomUUID(),
    name,
    models,
    strategy,
    stickyLimit,
  };
}

export function listModelCombos() {
  const combos = readState().modelCombos;
  return Array.isArray(combos) ? combos : [];
}

export function getModelCombo(name) {
  return listModelCombos().find((combo) => combo.name === name) || null;
}

export function createModelCombo(raw) {
  const combos = listModelCombos();
  const combo = normalizeCombo(raw);
  if (combos.some((item) => item.name === combo.name)) {
    throw Object.assign(new Error(`Combo "${combo.name}" already exists.`), { status: 409, expected: true });
  }
  writeState({ modelCombos: [...combos, combo] });
  return combo;
}

export function updateModelCombo(id, raw) {
  const combos = listModelCombos();
  const index = combos.findIndex((combo) => combo.id === id);
  if (index === -1) throw Object.assign(new Error("Combo not found."), { status: 404, expected: true });

  const previous = combos[index];
  const combo = normalizeCombo(raw, id);
  if (combos.some((item) => item.id !== id && item.name === combo.name)) {
    throw Object.assign(new Error(`Combo "${combo.name}" already exists.`), { status: 409, expected: true });
  }

  const next = [...combos];
  next[index] = combo;
  rotationState.delete(id);
  const state = readState();
  const enabledModelIds = state.enabledModelIds.includes(previous.name)
    ? state.enabledModelIds.map((modelId) => modelId === previous.name ? combo.name : modelId)
    : state.enabledModelIds;
  writeState({ modelCombos: next, enabledModelIds });
  return combo;
}

export function deleteModelCombo(id) {
  const combos = listModelCombos();
  const combo = combos.find((item) => item.id === id);
  if (!combo) throw Object.assign(new Error("Combo not found."), { status: 404, expected: true });

  const state = readState();
  writeState({
    modelCombos: combos.filter((item) => item.id !== id),
    enabledModelIds: state.enabledModelIds.filter((modelId) => modelId !== combo.name),
  });
  rotationState.delete(id);
  return combo;
}

function needsVision(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((message) => Array.isArray(message?.content) && message.content.some((part) => {
    const type = String(part?.type || "");
    return type === "image_url" || type === "image" || type === "input_image";
  }));
}

function prioritizeCapabilities(models, body) {
  if (!needsVision(body)) return models;
  const capabilities = readState().modelCapabilities || {};
  return models
    .map((model, index) => ({ model, index, rank: capabilities[model]?.vision === true ? 0 : capabilities[model]?.vision === false ? 2 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.model);
}

export function orderedComboModels(combo, body) {
  if (!combo) return [];
  if (combo.strategy !== "round-robin" || combo.models.length < 2) {
    return prioritizeCapabilities(prioritizeModelsByBudget(combo.models), body);
  }

  const current = rotationState.get(combo.id) || { index: 0, uses: 0 };
  const index = current.index % combo.models.length;
  const ordered = [...combo.models.slice(index), ...combo.models.slice(0, index)];
  const uses = current.uses + 1;
  rotationState.set(combo.id, uses >= combo.stickyLimit
    ? { index: (index + 1) % combo.models.length, uses: 0 }
    : { index, uses });
  return prioritizeCapabilities(prioritizeModelsByBudget(ordered), body);
}

export function shouldFallback(status, message = "") {
  const text = String(message).toLowerCase();
  if ([404, 408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  if (status === 401 || status === 403) return true;
  return /quota|rate.?limit|overload|temporar|unavailable|no credentials|cooldown|capacity|timeout|image|vision|modalit|multimodal|unsupported content/.test(text);
}