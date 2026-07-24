import { backendUrl } from "./config.js";
import { broadcast } from "./events.js";
import fs from "node:fs";
import {
  getRoot,
  buildTree,
  resolveInside,
  isSecretPath,
  createCheckpoint,
  getLastCheckpoint,
} from "./cowork-project.js";
import { requestApproval, rejectApprovalsFor } from "./approvals.js";
import { toolsForSession, toolSchemas, byName, type Tool } from "./tools/index.js";
import type { ToolCallView } from "./cowork-types.js";
import { getSettings, type CoworkPolicy } from "./app-settings.js";

/** Tools that mutate the project — auto-checkpoint once before first write/run. */
const MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_file",
  "delete_file",
  "run_command",
]);

// In-app Chat + Cowork agent loop (HANDBOOK M1 / COWORK §6).
// Renderer never fetches 127.0.0.1 (CSP connect-src 'none'); MAIN streams from
// the verbatim chat-proxy and re-broadcasts tokens / tool / approval events.

let cachedKey: string | null = null;
async function proxyKey(): Promise<string> {
  if (cachedKey !== null) return cachedKey;
  try {
    const r = await fetch(`${backendUrl()}/api/models/export`);
    const json = (await r.json()) as { apiKey?: string };
    cachedKey = json.apiKey ?? "";
  } catch {
    cachedKey = "";
  }
  return cachedKey;
}

const inflight = new Map<string, AbortController>();

type ApiMessage = {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
};

export interface ChatStartPayload {
  reqId: string;
  model: string;
  messages: ApiMessage[];
  temperature?: number;
  maxTokens?: number;
  /** M6 web fetch_url tool */
  useTools?: boolean;
  /** Cowork Mode: filesystem + shell tools (requires project root) */
  cowork?: boolean;
  /** Composer mode: ask = no tools; chat = optional fetch_url; agent = cowork tools */
  mode?: "ask" | "chat" | "agent";
  /** Override settings coworkPolicy for this turn */
  policy?: CoworkPolicy;
  /** Override max tool rounds for this turn (0 = defaults) */
  maxToolCalls?: number;
}

const MAX_CHAT_TOOL_ROUNDS = 4;
const MAX_COWORK_ROUNDS = 25;

/** Decide whether a needsApproval tool may auto-run under the active policy. */
function policyAllowsAuto(policy: CoworkPolicy, tool: Tool): "auto" | "ask" | "deny" {
  if (!tool.needsApproval) return "auto";
  switch (policy) {
    case "readonly":
      return "deny";
    case "safe":
      return "ask";
    case "trusted":
      return tool.danger ? "ask" : "auto";
    case "full":
      return "auto";
    default:
      return "ask";
  }
}

function emit(payload: Record<string, unknown>): void {
  broadcast("chat", payload);
}

/** Neuron path-A: whole in-app turn (not per HTTP hop). See graph STICKY + source chat. */
function emitActivity(evt: {
  phase: "start" | "end";
  reqId: string;
  model: string;
  ok?: boolean;
  latency_ms?: number;
  ts: number;
}): void {
  const m = evt.model.toLowerCase();
  let provider = "unknown";
  if (m.includes("claude")) provider = "anthropic";
  else if (m.includes("gemini")) provider = "gemini";
  else if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) provider = "openai";
  else if (m.includes("grok")) provider = "xai";
  broadcast("activity", { ...evt, provider, source: "chat" });
}

function buildRequest(
  p: ChatStartPayload,
  messages: ApiMessage[],
  key: string,
  signal: AbortSignal,
  tools: Tool[]
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
    ...(tools.length ? { tools: toolSchemas(tools), tool_choice: "auto" } : {}),
  };
  return fetch(`${backendUrl()}/api/proxy/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal,
  });
}

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

interface StreamResult {
  text: string;
  toolCalls: ToolCallAcc[];
  finish?: string;
}

async function streamOnce(reqId: string, body: ReadableStream<Uint8Array>): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const toolAcc = new Map<number, ToolCallAcc>();
  let buf = "";
  let text = "";
  let finish: string | undefined;

  const result = (): StreamResult => ({
    text,
    toolCalls: [...toolAcc.values()].filter((t) => t.name),
    finish,
  });

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") return result();
      try {
        const json = JSON.parse(data) as {
          choices?: {
            delta?: {
              content?: string;
              tool_calls?: {
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string | null;
          }[];
          usage?: unknown;
        };
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          text += delta.content;
          emit({ reqId, type: "delta", text: delta.content });
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const cur = toolAcc.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(tc.index, cur);
          }
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (json.usage) emit({ reqId, type: "usage", usage: json.usage });
      } catch {
        /* keep-alive */
      }
    }
  }
  return result();
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function injectCoworkContext(messages: ApiMessage[]): ApiMessage[] {
  const root = getRoot();
  if (!root) return messages;
  const tree = buildTree(".", 2);

  // Prefer small project entrypoints so the model orients without extra tools (C6).
  const snippets: string[] = [];
  for (const candidate of ["README.md", "readme.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
    try {
      if (isSecretPath(candidate)) continue;
      const abs = resolveInside(candidate);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      if (fs.statSync(abs).size > 80_000) continue;
      let body = fs.readFileSync(abs, "utf8");
      if (body.length > 4000) body = body.slice(0, 4000) + "\n…(truncated)";
      snippets.push(`### ${candidate}\n\`\`\`\n${body}\n\`\`\``);
      if (snippets.length >= 2) break;
    } catch {
      /* missing / blocked */
    }
  }

  const sys = [
    "You are Cowork Mode: an agentic coding assistant with tools to read, edit, create, delete files, search, and run shell commands inside the user's project.",
    "Rules:",
    "- Prefer read_file / list_dir / search before editing.",
    "- Always use relative paths from the project root.",
    "- Keep edits minimal and correct; write complete file contents for edit_file/write_file.",
    "- Never try to escape the project root.",
    "- Do not read or write secret files (.env, keys, credentials).",
    "- run_command is approval-gated and blocked for destructive patterns; prefer npm/test/build scripts over raw shell.",
    "",
    `Project root: ${root}`,
    "Folder tree (truncated):",
    "```",
    tree,
    "```",
    ...(snippets.length
      ? ["", "Project entry files (truncated — use read_file for more):", ...snippets]
      : []),
  ].join("\n");

  const out = [...messages];
  const hasSystem = out.some((m) => m.role === "system");
  if (!hasSystem) {
    out.unshift({ role: "system", content: sys });
  } else {
    const idx = out.findIndex((m) => m.role === "system");
    out.splice(idx + 1, 0, { role: "system", content: sys });
  }
  return out;
}

async function executeToolCall(
  reqId: string,
  tools: Tool[],
  tc: ToolCallAcc,
  signal: AbortSignal,
  policy: CoworkPolicy
): Promise<string> {
  const tool = byName(tools, tc.name);
  const args = parseArgs(tc.args);
  const view: ToolCallView = {
    id: tc.id || tc.name,
    name: tc.name,
    args,
    status: "running",
  };
  emit({ reqId, type: "tool", view, name: tc.name, status: "running" });

  if (!tool) {
    const err = `Unknown tool: ${tc.name}`;
    emit({ reqId, type: "tool", view: { ...view, status: "error", error: err }, name: tc.name, status: "error" });
    return `Error: ${err}`;
  }

  try {
    if (tool.needsApproval) {
      let preview;
      try {
        preview = tool.prepareApproval?.(args) ?? {
          title: tool.name,
          detail: JSON.stringify(args, null, 2),
          danger: !!tool.danger,
        };
      } catch (prepErr) {
        const msg = prepErr instanceof Error ? prepErr.message : String(prepErr);
        emit({
          reqId,
          type: "tool",
          view: { ...view, status: "error", error: msg },
          name: tc.name,
          status: "error",
        });
        return `Error preparing tool: ${msg}`;
      }

      const gate = policyAllowsAuto(policy, tool);
      if (gate === "deny") {
        emit({
          reqId,
          type: "tool",
          view: {
            ...view,
            status: "rejected",
            summary: "Blocked by readonly policy",
            diff: preview.diff,
          },
          name: tc.name,
          status: "rejected",
        });
        return "Blocked by cowork policy (readonly): mutating tools are not allowed.";
      }

      if (gate === "ask") {
        const ok = await requestApproval({
          reqId,
          tool: tool.name,
          title: preview.title,
          detail: preview.detail,
          danger: preview.danger || !!tool.danger,
          diff: preview.diff,
        });
        if (!ok || signal.aborted) {
          emit({
            reqId,
            type: "tool",
            view: { ...view, status: "rejected", summary: "Rejected by user", diff: preview.diff },
            name: tc.name,
            status: "rejected",
          });
          return "User rejected this action.";
        }
      }
      // gate === "auto" → skip approval UI
    }

    if (signal.aborted) {
      emit({ reqId, type: "tool", view: { ...view, status: "aborted" }, name: tc.name, status: "aborted" });
      return "Aborted.";
    }

    // Auto-checkpoint once before the first mutating tool in a session (so Undo works).
    if (MUTATING_TOOLS.has(tool.name) && getRoot() && !getLastCheckpoint()) {
      try {
        await createCheckpoint();
      } catch {
        /* best-effort — approval already granted; proceed without blocking */
      }
    }

    let lastPatch: Partial<ToolCallView> = {};
    const result = await tool.run(args, {
      signal,
      emit: (patch) => {
        // Ignore undefined fields so partial progress patches don't wipe summary/diff.
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) (lastPatch as Record<string, unknown>)[k] = v;
        }
        emit({
          reqId,
          type: "tool",
          view: { ...view, ...lastPatch, status: patch.status ?? "running" },
          name: tc.name,
          status: patch.status ?? "running",
        });
      },
    });
    if (signal.aborted) {
      emit({
        reqId,
        type: "tool",
        view: { ...view, ...lastPatch, status: "aborted" },
        name: tc.name,
        status: "aborted",
      });
      return "Aborted.";
    }
    // Keep summary/diff/output from tool emits — don't dump full read bodies into the UI view.
    const finalView: ToolCallView = { ...view, ...lastPatch, status: "ok" };
    emit({
      reqId,
      type: "tool",
      view: finalView,
      name: tc.name,
      status: "ok",
    });
    return result;
  } catch (err) {
    if (signal.aborted) {
      emit({
        reqId,
        type: "tool",
        view: { ...view, status: "aborted" },
        name: tc.name,
        status: "aborted",
      });
      return "Aborted.";
    }
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      reqId,
      type: "tool",
      view: { ...view, status: "error", error: msg },
      name: tc.name,
      status: "error",
    });
    return `Error: ${msg}`;
  }
}

export async function startChat(p: ChatStartPayload): Promise<void> {
  // Replace a previous controller for the same reqId (defensive).
  inflight.get(p.reqId)?.abort();
  const ctrl = new AbortController();
  inflight.set(p.reqId, ctrl);

  const settings = getSettings();
  // Coerce unknown mode values from older clients / bad payloads.
  const mode: "ask" | "chat" | "agent" =
    p.mode === "ask" || p.mode === "chat" || p.mode === "agent"
      ? p.mode
      : p.cowork
        ? "agent"
        : p.useTools
          ? "chat"
          : "ask";
  // ask → no tools; chat → fetch_url only when useTools; agent → cowork tools when root set.
  // Agent without a project root still gets chat tools (fetch_url), not empty toolset.
  const hasRoot = !!getRoot();
  const coworkOn = mode === "agent" && hasRoot && p.cowork !== false;
  const useTools =
    mode === "ask" ? false : mode === "agent" ? true : !!p.useTools || coworkOn;
  const tools = toolsForSession({ useTools: useTools || coworkOn, cowork: coworkOn });
  const defaultMax = coworkOn ? MAX_COWORK_ROUNDS : MAX_CHAT_TOOL_ROUNDS;
  const budget =
    typeof p.maxToolCalls === "number" && p.maxToolCalls > 0
      ? p.maxToolCalls
      : settings.maxToolCalls > 0
        ? settings.maxToolCalls
        : defaultMax;
  const maxRounds = Math.max(1, Math.min(50, budget));
  const policy: CoworkPolicy =
    p.policy === "readonly" || p.policy === "safe" || p.policy === "trusted" || p.policy === "full"
      ? p.policy
      : settings.coworkPolicy ?? "safe";

  let messages: ApiMessage[] = [...p.messages];
  if (coworkOn) messages = injectCoworkContext(messages);

  let toolExecCount = 0;
  // Neuron LIVE for the whole turn (tools + multi-round). Proxy hops still emit
  // their own start/end; graph folds them into this session firing.
  const activityStartedAt = Date.now();
  let activityEnded = false;
  const finishActivity = (ok: boolean) => {
    if (activityEnded) return;
    activityEnded = true;
    emitActivity({
      phase: "end",
      reqId: p.reqId,
      model: p.model,
      ok,
      latency_ms: Date.now() - activityStartedAt,
      ts: Date.now(),
    });
  };
  emitActivity({ phase: "start", reqId: p.reqId, model: p.model, ts: activityStartedAt });

  try {
    for (let round = 0; ; round++) {
      if (ctrl.signal.aborted) {
        emit({ reqId: p.reqId, type: "aborted" });
        finishActivity(false);
        return;
      }

      let res = await buildRequest(p, messages, await proxyKey(), ctrl.signal, tools);
      if (res.status === 401) {
        cachedKey = null;
        res = await buildRequest(p, messages, await proxyKey(), ctrl.signal, tools);
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        emit({ reqId: p.reqId, type: "error", error: `HTTP ${res.status} ${text}`.trim() });
        finishActivity(false);
        return;
      }

      const { text, toolCalls, finish } = await streamOnce(p.reqId, res.body);

      // Abort during SSE read: streamOnce may return with partial text; signal is set.
      if (ctrl.signal.aborted) {
        emit({ reqId: p.reqId, type: "aborted" });
        finishActivity(false);
        return;
      }

      const wantsTools =
        tools.length > 0 &&
        toolCalls.length > 0 &&
        (finish === "tool_calls" || finish === undefined || finish === null);

      if (!wantsTools || round >= maxRounds || toolExecCount >= maxRounds) {
        if (toolCalls.length > 0 && (round >= maxRounds || toolExecCount >= maxRounds)) {
          // Still emit any text already streamed; surface limit as error so UI shows it.
          emit({
            reqId: p.reqId,
            type: "error",
            error: `Tool budget reached (${maxRounds} max tool rounds/calls)`,
          });
          finishActivity(false);
        } else {
          emit({ reqId: p.reqId, type: "done" });
          finishActivity(true);
        }
        return;
      }

      // Ensure every tool_call has a stable id (some providers omit id on later indices).
      const normalizedCalls = toolCalls.map((tc, i) => ({
        ...tc,
        id: tc.id || `call_${round}_${i}`,
      }));

      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: normalizedCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        })),
      });

      for (const tc of normalizedCalls) {
        if (ctrl.signal.aborted) {
          emit({ reqId: p.reqId, type: "aborted" });
          finishActivity(false);
          return;
        }
        if (toolExecCount >= maxRounds) {
          emit({
            reqId: p.reqId,
            type: "error",
            error: `Tool budget reached (${maxRounds} max tool calls)`,
          });
          finishActivity(false);
          return;
        }
        toolExecCount += 1;
        const toolResult = await executeToolCall(p.reqId, tools, tc, ctrl.signal, policy);
        messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
      }
    }
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") emit({ reqId: p.reqId, type: "aborted" });
    else emit({ reqId: p.reqId, type: "error", error: e?.message ?? String(err) });
    finishActivity(false);
  } finally {
    // Safety net if a path forgot finishActivity (should not happen).
    finishActivity(true);
    rejectApprovalsFor(p.reqId);
    inflight.delete(p.reqId);
  }
}

export function abortChat(reqId: string): void {
  rejectApprovalsFor(reqId);
  inflight.get(reqId)?.abort();
}
