/**
 * CLI Tools — one-click wiring of external coding CLIs/IDEs (Claude Code,
 * Codex, OpenCode, Cline, Factory Droid, Kilo, DeepSeek TUI, Hermes, Open Claw)
 * to THIS machine's local CLIProxyAPI, plus copy-paste "guide" cards for tools
 * that can't be configured by writing a file (Cursor, Roo, Continue, Amp, Qwen,
 * Grok Build, jcode).
 *
 * Ported from 9router's per-tool `*-settings/route.js` writers so the exact
 * config-file shapes each tool expects are reproduced faithfully. Two important
 * differences from 9router:
 *   1. Endpoint + API key are auto-filled from the running CLIProxyAPI (its own
 *      proxy key + port) instead of being pasted by the user.
 *   2. Claude Code's ANTHROPIC_BASE_URL is written WITHOUT a `/v1` suffix. The
 *      Anthropic SDK appends `/v1/messages` itself, so a base URL ending in
 *      `/v1` becomes `/v1/v1/messages` -> 404 on CLIProxyAPI (which only serves
 *      `/v1/messages`). 9router tolerates the doubled path; CLIProxyAPI does
 *      not. OpenAI-compatible tools DO get `/v1` (they hit `/v1/chat/completions`
 *      / `/v1/responses`).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import yaml from "js-yaml";
import { settings } from "./settings.js";

const home = () => os.homedir();
const isWin = () => os.platform() === "win32";

// --- endpoint + key from the running CLIProxyAPI -----------------------------
function proxyInfo() {
  const host = settings.cliproxyHost || "127.0.0.1";
  const base = `http://${host}:${settings.cliproxyPort}`;
  let key = settings.proxyApiKey || "";
  if (!key) {
    try {
      const raw = fs.readFileSync(path.join(settings.cliproxyHome, "renn-copilot-keys.json"), "utf8");
      key = JSON.parse(raw).proxyApiKey || "";
    } catch {
      /* key stays empty; apply still works, calls will just 401 until server is up */
    }
  }
  return { base, key };
}
// Anthropic base (no /v1 — SDK adds /v1/messages). OpenAI base (with /v1).
const anthropicBase = () => proxyInfo().base;
const openaiBase = () => `${proxyInfo().base}/v1`;

// --- small fs helpers --------------------------------------------------------
async function readJson(file) {
  try {
    const txt = await fsp.readFile(file, "utf8");
    // Tolerate trailing commas (JSONC-ish hand edits).
    return JSON.parse(txt.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}
async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
}
async function readText(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}
async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
// Best-effort `which`/`where`, bounded so a slow PATH scan can't hang the list.
function commandExists(cmd) {
  return new Promise((resolve) => {
    const which = isWin() ? `where ${cmd}` : `which ${cmd}`;
    const env = isWin() ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` } : process.env;
    const child = exec(which, { windowsHide: true, env, timeout: 1500 }, (err) => resolve(!err));
    child.on("error", () => resolve(false));
  });
}

// --- minimal TOML section/key helpers (no TOML dep in this project) ----------
// Strip a top-level `key = ...` line.
function stripTomlKey(text, key) {
  return text.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n)?`, "m"), "");
}
// Strip a `[header]` (or `[header.sub]`) table up to the next table header/EOF.
function stripTomlTable(text, header) {
  const esc = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)\\[${esc}\\][^\\n]*\\n(?:(?!\\s*\\[)[^\\n]*\\n?)*`, "g");
  return text.replace(re, "\n");
}
const q = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

// -----------------------------------------------------------------------------
// Writers. Each returns { detect, apply, reset }. `detect` reports install +
// whether it's currently pointed at a local proxy. `apply(body)` takes the
// renderer-chosen model(s); base URL + key come from proxyInfo().
// -----------------------------------------------------------------------------

// Claude Code — ~/.claude/settings.json env block (Anthropic wire, NO /v1).
const CLAUDE_ENV = {
  base: "ANTHROPIC_BASE_URL",
  token: "ANTHROPIC_AUTH_TOKEN",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
};
const claude = {
  settingsPath: () => path.join(home(), ".claude", "settings.json"),
  async detect() {
    const s = await readJson(claude.settingsPath());
    const installed = (await commandExists("claude")) || (await fileExists(claude.settingsPath()));
    const url = s?.env?.[CLAUDE_ENV.base] || "";
    return {
      installed,
      configured: !!url,
      current: {
        endpoint: url,
        fable: s?.env?.[CLAUDE_ENV.fable] || "",
        opus: s?.env?.[CLAUDE_ENV.opus] || "",
        sonnet: s?.env?.[CLAUDE_ENV.sonnet] || "",
        haiku: s?.env?.[CLAUDE_ENV.haiku] || "",
      },
    };
  },
  async apply({ fable, opus, sonnet, haiku }) {
    const file = claude.settingsPath();
    const cur = (await readJson(file)) || {};
    const { key } = proxyInfo();
    const env = { ...(cur.env || {}) };
    env[CLAUDE_ENV.base] = anthropicBase();
    env[CLAUDE_ENV.token] = key;
    if (fable) env[CLAUDE_ENV.fable] = fable;
    if (opus) env[CLAUDE_ENV.opus] = opus;
    if (sonnet) env[CLAUDE_ENV.sonnet] = sonnet;
    if (haiku) env[CLAUDE_ENV.haiku] = haiku;
    await writeJson(file, { ...cur, hasCompletedOnboarding: true, env });
  },
  async reset() {
    const file = claude.settingsPath();
    const cur = await readJson(file);
    if (!cur?.env) return;
    for (const k of Object.values(CLAUDE_ENV)) delete cur.env[k];
    if (Object.keys(cur.env).length === 0) delete cur.env;
    await writeJson(file, cur);
  },
};

// Codex — ~/.codex/config.toml (provider + wire_api) + ~/.codex/auth.json key.
const codex = {
  dir: () => path.join(home(), ".codex"),
  cfg: () => path.join(codex.dir(), "config.toml"),
  auth: () => path.join(codex.dir(), "auth.json"),
  async detect() {
    const txt = await readText(codex.cfg());
    const installed = (await commandExists("codex")) || (await fileExists(codex.cfg()));
    return {
      installed,
      configured: txt.includes('model_provider = "wan-renn"') || txt.includes("[model_providers.wan-renn]"),
      current: { model: (txt.match(/^model\s*=\s*"([^"]*)"/m) || [])[1] || "" },
    };
  },
  async apply({ model }) {
    await fsp.mkdir(codex.dir(), { recursive: true });
    let txt = await readText(codex.cfg());
    // Drop previously-managed keys/tables, then re-emit ours.
    txt = stripTomlKey(txt, "model");
    txt = stripTomlKey(txt, "model_provider");
    txt = stripTomlTable(txt, "model_providers.wan-renn");
    txt = stripTomlTable(txt, "model_providers.9router"); // clean up pre-rename config
    txt = stripTomlTable(txt, "agents.subagent");
    const managed =
      `model = ${q(model)}\n` +
      `model_provider = "wan-renn"\n\n` +
      `[model_providers.wan-renn]\n` +
      `name = "WANN X RENN CLIProxyAPI"\n` +
      `base_url = ${q(openaiBase())}\n` +
      `wire_api = "responses"\n\n` +
      `[agents.subagent]\n` +
      `model = ${q(model)}\n`;
    const body = txt.trim();
    await fsp.writeFile(codex.cfg(), managed + (body ? `\n${body}\n` : ""));
    // Codex reads OPENAI_API_KEY from auth.json first.
    const auth = (await readJson(codex.auth())) || {};
    auth.OPENAI_API_KEY = proxyInfo().key;
    await writeJson(codex.auth(), auth);
  },
  async reset() {
    let txt = await readText(codex.cfg());
    if (txt) {
      txt = stripTomlKey(txt, "model_provider");
      txt = stripTomlTable(txt, "model_providers.wan-renn");
      txt = stripTomlTable(txt, "model_providers.9router");
      txt = stripTomlTable(txt, "agents.subagent");
      await fsp.writeFile(codex.cfg(), txt.replace(/^\n+/, ""));
    }
    const auth = await readJson(codex.auth());
    if (auth && "OPENAI_API_KEY" in auth) {
      delete auth.OPENAI_API_KEY;
      await writeJson(codex.auth(), auth);
    }
  },
};

// OpenCode — ~/.config/opencode/opencode.json (openai-compatible provider).
const opencode = {
  cfg: () => path.join(home(), ".config", "opencode", "opencode.json"),
  async detect() {
    const c = await readJson(opencode.cfg());
    const installed = (await commandExists("opencode")) || (await fileExists(opencode.cfg()));
    const p = c?.provider?.["wan-renn"];
    return {
      installed,
      configured: !!p,
      current: { model: c?.model?.startsWith("wan-renn/") ? c.model.replace(/^wan-renn\//, "") : "" },
    };
  },
  async apply({ model }) {
    const file = opencode.cfg();
    const c = (await readJson(file)) || {};
    if (!c.provider) c.provider = {};
    delete c.provider["9router"]; // clean up pre-rename provider block
    const prev = c.provider["wan-renn"] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };
    prev.options = { ...prev.options, baseURL: openaiBase(), apiKey: proxyInfo().key };
    prev.models = prev.models || {};
    prev.models[model] = { name: model, modalities: { input: ["text", "image"], output: ["text"] } };
    c.provider["wan-renn"] = prev;
    c.model = `wan-renn/${model}`;
    if (!c.agent) c.agent = {};
    c.agent.explorer = { description: "Fast explorer subagent for codebase exploration", mode: "subagent", model: `wan-renn/${model}` };
    await writeJson(file, c);
  },
  async reset() {
    const c = await readJson(opencode.cfg());
    if (!c) return;
    if (c.provider) {
      delete c.provider["wan-renn"];
      delete c.provider["9router"];
    }
    if (typeof c.model === "string" && (c.model.startsWith("wan-renn/") || c.model.startsWith("9router/"))) delete c.model;
    if (c.agent) delete c.agent.explorer;
    await writeJson(opencode.cfg(), c);
  },
};

// Cline — ~/.cline/data/globalState.json + secrets.json (openai provider).
const cline = {
  dir: () => path.join(home(), ".cline", "data"),
  state: () => path.join(cline.dir(), "globalState.json"),
  secrets: () => path.join(cline.dir(), "secrets.json"),
  async detect() {
    const gs = await readJson(cline.state());
    const installed = (await commandExists("cline")) || (await fileExists(cline.state()));
    const url = gs?.openAiBaseUrl || "";
    const openai = gs?.actModeApiProvider === "openai" || gs?.planModeApiProvider === "openai";
    return { installed, configured: openai && /localhost|127\.0\.0\.1/.test(url), current: { model: gs?.openAiModelId || "" } };
  },
  async apply({ model }) {
    await fsp.mkdir(cline.dir(), { recursive: true });
    const gs = (await readJson(cline.state())) || {};
    gs.actModeApiProvider = "openai";
    gs.planModeApiProvider = "openai";
    gs.openAiBaseUrl = openaiBase();
    gs.openAiModelId = model;
    gs.planModeOpenAiModelId = model;
    await writeJson(cline.state(), gs);
    const sec = (await readJson(cline.secrets())) || {};
    sec.openAiApiKey = proxyInfo().key;
    await writeJson(cline.secrets(), sec);
  },
  async reset() {
    const gs = await readJson(cline.state());
    if (gs) {
      if (gs.actModeApiProvider === "openai") {
        delete gs.openAiBaseUrl;
        delete gs.openAiModelId;
        delete gs.planModeOpenAiModelId;
        gs.actModeApiProvider = "cline";
        gs.planModeApiProvider = "cline";
      }
      await writeJson(cline.state(), gs);
    }
    const sec = await readJson(cline.secrets());
    if (sec) {
      delete sec.openAiApiKey;
      await writeJson(cline.secrets(), sec);
    }
  },
};

// Factory Droid — ~/.factory/settings.json customModels[] (openai provider).
const droid = {
  cfg: () => path.join(home(), ".factory", "settings.json"),
  async detect() {
    const s = await readJson(droid.cfg());
    const installed = (await commandExists("droid")) || (await fileExists(droid.cfg()));
    const list = (s?.customModels || []).filter((m) => m.id?.startsWith("custom:wan-renn"));
    return { installed, configured: list.length > 0, current: { model: list[0]?.model || "" } };
  },
  async apply({ model }) {
    const file = droid.cfg();
    const s = (await readJson(file)) || {};
    if (!s.customModels) s.customModels = [];
    s.customModels = s.customModels.filter((m) => !m.id?.startsWith("custom:wan-renn"));
    s.customModels.unshift({
      model,
      id: "custom:wan-renn-0",
      index: 0,
      baseUrl: openaiBase(),
      apiKey: proxyInfo().key,
      displayName: model,
      maxOutputTokens: 131072,
      noImageSupport: false,
      provider: "openai",
    });
    s.customModels.forEach((m, i) => (m.index = i));
    await writeJson(file, s);
  },
  async reset() {
    const s = await readJson(droid.cfg());
    if (!s?.customModels) return;
    s.customModels = s.customModels.filter((m) => !m.id?.startsWith("custom:wan-renn"));
    await writeJson(droid.cfg(), s);
  },
};

// Kilo Code — ~/.local/share/kilo/auth.json (+ VS Code settings best-effort).
const kilo = {
  auth: () => path.join(home(), ".local", "share", "kilo", "auth.json"),
  vscode: () => path.join(home(), ".config", "Code", "User", "settings.json"),
  async detect() {
    const a = await readJson(kilo.auth());
    const installed = (await commandExists("kilo")) || (await fileExists(kilo.auth()));
    const e = a?.["openai-compatible"];
    const url = e?.baseUrl || e?.baseURL || "";
    return { installed, configured: /localhost|127\.0\.0\.1/.test(url), current: { model: e?.model || "" } };
  },
  async apply({ model }) {
    await fsp.mkdir(path.dirname(kilo.auth()), { recursive: true });
    const a = (await readJson(kilo.auth())) || {};
    a["openai-compatible"] = { type: "api-key", apiKey: proxyInfo().key, baseUrl: openaiBase(), model };
    await writeJson(kilo.auth(), a);
    try {
      const v = (await readJson(kilo.vscode())) || {};
      v["kilocode.customProvider"] = { name: "WANN X RENN CLIProxyAPI", baseURL: openaiBase(), apiKey: proxyInfo().key };
      v["kilocode.defaultModel"] = model;
      await writeJson(kilo.vscode(), v);
    } catch {
      /* VS Code settings not writable — ignore */
    }
  },
  async reset() {
    const a = await readJson(kilo.auth());
    if (a) {
      delete a["openai-compatible"];
      delete a["9router"];
      await writeJson(kilo.auth(), a);
    }
    const v = await readJson(kilo.vscode());
    if (v) {
      delete v["kilocode.customProvider"];
      delete v["kilocode.defaultModel"];
      await writeJson(kilo.vscode(), v);
    }
  },
};

// DeepSeek TUI — ~/.deepseek/config.toml (openai provider). 9router rewrites
// the whole file; we do the same but keep it minimal.
const deepseek = {
  cfg: () => path.join(home(), ".deepseek", "config.toml"),
  async detect() {
    const txt = await readText(deepseek.cfg());
    const installed = (await commandExists("deepseek")) || (await fileExists(deepseek.cfg()));
    return {
      installed,
      configured: /provider\s*=\s*"openai"/.test(txt) && /localhost|127\.0\.0\.1/.test(txt),
      current: { model: (txt.match(/model\s*=\s*"([^"]*)"/) || [])[1] || "" },
    };
  },
  async apply({ model }) {
    await fsp.mkdir(path.dirname(deepseek.cfg()), { recursive: true });
    const toml =
      `provider = "openai"\n\n` +
      `[providers.openai]\n` +
      `base_url = ${q(openaiBase())}\n` +
      `api_key = ${q(proxyInfo().key)}\n` +
      `model = ${q(model)}\n`;
    await fsp.writeFile(deepseek.cfg(), toml);
  },
  async reset() {
    if (await fileExists(deepseek.cfg())) await fsp.writeFile(deepseek.cfg(), `provider = "deepseek"\n`);
  },
};

// Hermes Agent — ~/.hermes/config.yaml model block + ~/.hermes/.env key.
const hermes = {
  cfg: () => path.join(home(), ".hermes", "config.yaml"),
  env: () => path.join(home(), ".hermes", ".env"),
  async detect() {
    const txt = await readText(hermes.cfg());
    const installed = (await commandExists("hermes")) || (await fileExists(hermes.cfg()));
    let doc = {};
    try {
      doc = yaml.load(txt) || {};
    } catch {
      doc = {};
    }
    const url = doc?.model?.base_url || "";
    return { installed, configured: /localhost|127\.0\.0\.1/.test(url), current: { model: doc?.model?.default || "" } };
  },
  async apply({ model }) {
    await fsp.mkdir(path.dirname(hermes.cfg()), { recursive: true });
    let doc = {};
    try {
      doc = yaml.load(await readText(hermes.cfg())) || {};
    } catch {
      doc = {};
    }
    doc.model = { default: model, provider: "custom", base_url: openaiBase() };
    await fsp.writeFile(hermes.cfg(), yaml.dump(doc));
    // .env — upsert OPENAI_API_KEY line.
    let envTxt = await readText(hermes.env());
    const line = `OPENAI_API_KEY=${proxyInfo().key}`;
    envTxt = /^OPENAI_API_KEY=.*$/m.test(envTxt) ? envTxt.replace(/^OPENAI_API_KEY=.*$/m, line) : `${envTxt}${envTxt && !envTxt.endsWith("\n") ? "\n" : ""}${line}\n`;
    await fsp.writeFile(hermes.env(), envTxt);
  },
  async reset() {
    try {
      const doc = yaml.load(await readText(hermes.cfg()));
      if (doc?.model) {
        delete doc.model;
        await fsp.writeFile(hermes.cfg(), yaml.dump(doc));
      }
    } catch {
      /* ignore */
    }
    const envTxt = await readText(hermes.env());
    if (envTxt) await fsp.writeFile(hermes.env(), envTxt.replace(/^OPENAI_API_KEY=.*\r?\n?/m, ""));
  },
};

// Open Claw — ~/.openclaw/openclaw.json models.providers["wan-renn"].
const openclaw = {
  cfg: () => path.join(home(), ".openclaw", "openclaw.json"),
  async detect() {
    const s = await readJson(openclaw.cfg());
    const installed = (await commandExists("openclaw")) || (await fileExists(openclaw.cfg()));
    const p = s?.models?.providers?.["wan-renn"];
    return { installed, configured: !!p, current: { model: p?.models?.[0]?.id || "" } };
  },
  async apply({ model }) {
    const file = openclaw.cfg();
    const s = (await readJson(file)) || {};
    if (!s.models) s.models = {};
    if (!s.models.providers) s.models.providers = {};
    delete s.models.providers["9router"]; // clean up pre-rename provider block
    s.models.providers["wan-renn"] = {
      baseUrl: openaiBase(),
      apiKey: proxyInfo().key,
      api: "openai-completions",
      models: [{ id: model, name: model.split("/").pop() || model }],
    };
    await writeJson(file, s);
  },
  async reset() {
    const s = await readJson(openclaw.cfg());
    if (s?.models?.providers) {
      delete s.models.providers["wan-renn"];
      delete s.models.providers["9router"];
      await writeJson(openclaw.cfg(), s);
    }
  },
};

const WRITERS = { claude, codex, opencode, cline, droid, kilo, "deepseek-tui": deepseek, hermes, openclaw };

// -----------------------------------------------------------------------------
// Catalog — metadata the renderer needs to draw every card. `kind: "writer"`
// tools are configured server-side (WRITERS above); `kind: "guide"` tools show
// copy-paste steps with {{baseUrl}}/{{apiKey}}/{{model}} placeholders.
// `api` decides which base URL the guide/apply uses. `slots` are the model
// dropdowns a writer card renders (Claude has four; the rest have one).
// -----------------------------------------------------------------------------
const CATALOG = [
  {
    id: "claude", name: "Claude Code", description: "Anthropic Claude Code CLI", color: "#D97757",
    kind: "writer", api: "anthropic", configFile: "~/.claude/settings.json",
    slots: [
      { key: "fable", label: "Claude Fable" },
      { key: "opus", label: "Claude Opus" },
      { key: "sonnet", label: "Claude Sonnet" },
      { key: "haiku", label: "Claude Haiku" },
    ],
  },
  { id: "codex", name: "OpenAI Codex CLI", description: "OpenAI Codex CLI", color: "#10A37F", kind: "writer", api: "openai", configFile: "~/.codex/config.toml", slots: [{ key: "model", label: "Model" }] },
  { id: "opencode", name: "OpenCode", description: "OpenCode terminal assistant", color: "#E87040", kind: "writer", api: "openai", configFile: "~/.config/opencode/opencode.json", slots: [{ key: "model", label: "Model" }] },
  { id: "cline", name: "Cline", description: "Cline coding assistant", color: "#00D1B2", kind: "writer", api: "openai", configFile: "~/.cline/data/globalState.json", slots: [{ key: "model", label: "Model" }] },
  { id: "droid", name: "Factory Droid", description: "Factory Droid assistant", color: "#00D4FF", kind: "writer", api: "openai", configFile: "~/.factory/settings.json", slots: [{ key: "model", label: "Model" }] },
  { id: "kilo", name: "Kilo Code", description: "Kilo Code assistant", color: "#FF6B6B", kind: "writer", api: "openai", configFile: "~/.local/share/kilo/auth.json", slots: [{ key: "model", label: "Model" }] },
  { id: "deepseek-tui", name: "DeepSeek TUI", description: "DeepSeek terminal agent", color: "#4D6BFE", kind: "writer", api: "openai", configFile: "~/.deepseek/config.toml", slots: [{ key: "model", label: "Model" }] },
  { id: "hermes", name: "Hermes Agent", description: "Nous Research agent", color: "#8B5CF6", kind: "writer", api: "openai", configFile: "~/.hermes/config.yaml", slots: [{ key: "model", label: "Model" }] },
  { id: "openclaw", name: "Open Claw", description: "Open Claw assistant", color: "#FF6B35", kind: "writer", api: "openai", configFile: "~/.openclaw/openclaw.json", slots: [{ key: "model", label: "Model" }] },
  // --- guide (copy-paste) ----------------------------------------------------
  {
    id: "cursor", name: "Cursor", description: "Cursor editor (OpenAI-compatible)", color: "#8899A6", kind: "guide", api: "openai",
    steps: [
      "Settings → Models → enable “OpenAI API key”.",
      "Override Base URL: {{baseUrl}}",
      "API key: {{apiKey}}",
      "Add a custom model with the id: {{model}}",
    ],
    note: "Cursor routes through its own servers; a localhost endpoint only works with a tunnel/Cloud endpoint.",
  },
  {
    id: "roo", name: "Roo", description: "Roo assistant", color: "#FF6B6B", kind: "guide", api: "openai",
    steps: ["API Provider → OpenAI Compatible.", "Base URL: {{baseUrl}}", "API key: {{apiKey}}", "Model: {{model}}"],
  },
  {
    id: "continue", name: "Continue", description: "Continue assistant", color: "#7C3AED", kind: "guide", api: "openai",
    codeLang: "json",
    code: `{\n  "apiBase": "{{baseUrl}}",\n  "title": "{{model}}",\n  "model": "{{model}}",\n  "provider": "openai",\n  "apiKey": "{{apiKey}}"\n}`,
  },
  {
    id: "amp", name: "Amp CLI", description: "Sourcegraph Amp CLI", color: "#F97316", kind: "guide", api: "openai",
    codeLang: "bash",
    code: `export OPENAI_API_KEY="{{apiKey}}"\nexport OPENAI_BASE_URL="{{baseUrl}}"\namp --model "{{model}}"`,
  },
  {
    id: "qwen", name: "Qwen Code", description: "Qwen Code CLI", color: "#10B981", kind: "guide", api: "openai",
    codeLang: "json",
    code: `{\n  "security": {\n    "auth": {\n      "selectedType": "openai",\n      "apiKey": "{{apiKey}}",\n      "baseUrl": "{{baseUrl}}"\n    }\n  },\n  "model": { "name": "{{model}}" }\n}`,
    note: "Config path: ~/.qwen/settings.json",
  },
  {
    id: "grok-build", name: "Grok Build", description: "xAI Grok Build TUI", color: "#1DA1F2", kind: "guide", api: "openai",
    codeLang: "toml",
    code: `# ~/.grok/config.toml\n[model.wan-renn]\nbase_url = "{{baseUrl}}"\napi_key = "{{apiKey}}"\nmodel = "{{model}}"`,
    note: "After saving, run `grok` then `/model wan-renn`.",
  },
  {
    id: "jcode", name: "jcode", description: "Rust coding agent", color: "#FF6B35", kind: "guide", api: "openai",
    codeLang: "toml",
    code: `# ~/.jcode/config.toml\n[providers.wan-renn]\nbase_url = "{{baseUrl}}"\napi_key = "{{apiKey}}"\nmodel = "{{model}}"`,
  },
];

// Brand logo per tool, served from the renderer's public/providers/ folder.
// The card falls back to a colored letter tile if the image fails to load.
const LOGOS = {
  claude: "providers/claude.png",
  codex: "providers/codex.png",
  opencode: "providers/opencode.png",
  cline: "providers/cline.png",
  droid: "providers/droid.png",
  kilo: "providers/kilocode.png",
  "deepseek-tui": "providers/deepseek-tui.png",
  hermes: "providers/hermes.png",
  openclaw: "providers/openclaw.png",
  cursor: "providers/cursor.png",
  roo: "providers/roo.png",
  continue: "providers/continue.png",
  amp: "providers/amp.png",
  qwen: "providers/qwen.png",
  "grok-build": "providers/grok-cli.png",
  jcode: "providers/jcode.png",
};

// GET /cli-tools — catalog + live status (endpoint/key + per-tool detect()).
export async function listCliTools() {
  const { base, key } = proxyInfo();
  const tools = await Promise.all(
    CATALOG.map(async (t) => {
      const baseUrl = t.api === "anthropic" ? base : `${base}/v1`;
      const image = LOGOS[t.id] || null;
      if (t.kind !== "writer") return { ...t, baseUrl, image };
      let status = { installed: false, configured: false, current: {} };
      try {
        status = await WRITERS[t.id].detect();
      } catch {
        /* leave defaults */
      }
      return { ...t, baseUrl, image, ...status };
    })
  );
  return { endpoint: base, apiKey: key, tools };
}

// POST /cli-tools/:id — write the tool's config from chosen model(s).
export async function applyCliTool(id, body = {}) {
  const w = WRITERS[id];
  if (!w) throw Object.assign(new Error(`Unknown or non-writable tool: ${id}`), { status: 400 });
  await w.apply(body);
  return await w.detect();
}

// DELETE /cli-tools/:id — remove the tool's local-proxy config.
export async function resetCliTool(id) {
  const w = WRITERS[id];
  if (!w) throw Object.assign(new Error(`Unknown or non-writable tool: ${id}`), { status: 400 });
  await w.reset();
  return await w.detect();
}
