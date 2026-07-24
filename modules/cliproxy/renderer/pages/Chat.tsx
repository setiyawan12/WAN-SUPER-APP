import { useEffect, useRef, useState, useCallback } from "react";
import { api, type ModelEntry } from "../api/client";
import { toast } from "../components/ui";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { ModelPicker } from "../components/ModelPicker";
import { extractArtifacts, ArtifactsPanel } from "../components/Artifacts";
import { ratesFor, formatUsd, formatCompactNumber, estimateTokens, contextWindowForFamily, shortenPath } from "../lib/utils";
import type {
  ChatStreamEvent,
  ChatUsage,
  ChatAttachment,
  ChatMessageRecord,
  Conversation,
  ConversationSummary,
  ConversationSearchHit,
  Project,
  CoworkProject,
  ToolCallView,
  ApprovalRequest,
  ChatComposerMode,
  CoworkPolicy,
} from "../wan";
// CoworkState is returned by window.wan.cowork.state()

type ComposerMode = ChatComposerMode;

const MODE_META: Record<ComposerMode, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "No tools — answers only" },
  chat: { label: "Chat", hint: "Optional @file / URL context + fetch_url tools" },
  agent: { label: "Agent", hint: "Cowork filesystem + shell tools (folder required)" },
};

/** Copilot-style empty-state starter prompts (fill composer on click). */
const STARTER_PROMPTS = [
  { label: "Explain this project", text: "Explain the structure and purpose of this project." },
  { label: "How do I run tests?", text: "How do I run the tests for this project?" },
  { label: "Review recent changes", text: "Summarize what changed recently and any risks." },
  { label: "Suggest improvements", text: "Suggest the highest-impact improvements for this codebase." },
];

const POLICY_META: Record<CoworkPolicy, { label: string; hint: string }> = {
  readonly: { label: "Read-only", hint: "Block write/run tools" },
  safe: { label: "Safe", hint: "Always ask before write/run" },
  trusted: { label: "Trusted", hint: "Auto-approve safe writes; ask for shell/delete" },
  full: { label: "Full", hint: "Auto-approve all mutating tools" },
};

// HANDBOOK M4 — "Lampiran & persona": per-conversation system prompt, vision
// image attachments, per-message actions (Copy / Regenerate / Edit & resend).
// HANDBOOK M5 — "Konteks & artifacts": @-file + web-fetch context chips folded
// into the turn, and a live Artifacts side panel for ```html/```svg blocks.
// HANDBOOK M6 — "Quick-chat & tools": Projects/Spaces grouping in the sidebar
// and an opt-in local tool loop (fetch_url) — all on the M1–M3 core.
// Cowork Mode — folder agent (filesystem/shell tools + write/run approvals).

// A file/URL context source staged in the composer (M5). Consumed on send: its
// text is spliced into the user turn as a labelled block, then the chip clears.
interface ContextItem {
  id: string;
  kind: "file" | "url";
  label: string;
  text: string;
  truncated: boolean;
}

// Sentinel projectId for the "no project" bucket in the sidebar filter.
const UNFILED = "__unfiled__";

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function buildContextPreamble(items: ContextItem[]): string {
  if (!items.length) return "";
  const blocks = items.map((it) => {
    const head = it.kind === "file" ? `File: ${it.label}` : `Web page: ${it.label}`;
    const note = it.truncated ? " (truncated)" : "";
    return `[Context — ${head}${note}]\n${it.text}`;
  });
  return `${blocks.join("\n\n")}\n\n---\n\n`;
}

interface UsageInfo {
  input: number;
  output: number;
  total: number;
  costUsd: number;
}

interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  createdAt: number;
  usage?: UsageInfo;
  attachments?: ChatAttachment[];
  error?: string;
  streaming?: boolean;
  /** Tool timeline for this assistant turn (persisted with the conversation). */
  tools?: ToolCallView[];
}

function patch(list: UiMessage[], id: string, fn: (m: UiMessage) => UiMessage): UiMessage[] {
  return list.map((m) => (m.id === id ? fn(m) : m));
}

function mapUsage(u: ChatUsage, model: string): UsageInfo {
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  const total = u.total_tokens ?? input + output;
  const rate = ratesFor(model);
  return { input, output, total, costUsd: (input / 1e6) * rate.input + (output / 1e6) * rate.output };
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function makeTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  const words = t.split(" ").slice(0, 6).join(" ");
  return words.length < t.length ? `${words}…` : words;
}

function fromRecord(r: ChatMessageRecord): UiMessage {
  return {
    ...r,
    usage: r.usage ? { ...r.usage, costUsd: r.usage.costUsd ?? 0 } : undefined,
    streaming: false,
  };
}

// Persist the tool timeline, but cap large diff/output/error blobs so history
// files stay small.
function trimTool(t: ToolCallView): ToolCallView {
  const cap = (s: string | undefined, n: number) =>
    s && s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s;
  return { ...t, diff: cap(t.diff, 6000), output: cap(t.output, 4000), error: cap(t.error, 2000) };
}

function toRecord(m: UiMessage): ChatMessageRecord {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    createdAt: m.createdAt,
    usage: m.usage,
    attachments: m.attachments,
    error: m.error,
    tools: m.tools?.length ? m.tools.map(trimTool) : undefined,
  };
}

function upsertSummary(list: ConversationSummary[], s: ConversationSummary): ConversationSummary[] {
  return [s, ...list.filter((x) => x.id !== s.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

// OpenAI content: a plain string, or a parts array when images are attached
// (§7 / §4.3). chat-proxy forwards either shape straight through.
function toApiContent(m: UiMessage): unknown {
  if (!m.attachments?.length) return m.content;
  const parts: unknown[] = [];
  if (m.content) parts.push({ type: "text", text: m.content });
  for (const a of m.attachments) parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
  return parts;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="cowork-diff">
      {diff.split("\n").map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-del"
                : line.startsWith("@@")
                  ? "diff-hunk"
                  : undefined
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function toolIcon(name: string): string {
  switch (name) {
    case "read_file":
      return "📖";
    case "list_dir":
      return "📂";
    case "search":
      return "🔎";
    case "edit_file":
    case "write_file":
      return "✏️";
    case "create_file":
      return "➕";
    case "delete_file":
      return "🗑";
    case "run_command":
      return "▶";
    case "fetch_url":
      return "🔗";
    default:
      return "⚙";
  }
}

function normalizeToolStatus(status: ToolCallView["status"] | "done" | string): ToolCallView["status"] {
  if (status === "done") return "ok";
  if (
    status === "running" ||
    status === "ok" ||
    status === "error" ||
    status === "rejected" ||
    status === "aborted"
  ) {
    return status;
  }
  return "running";
}

function ToolTimeline({ tools, streaming }: { tools: ToolCallView[]; streaming?: boolean }) {
  // Skip transient placeholders that arrive before the tool name has streamed
  // in — otherwise they render as empty "thin line" rows.
  const shown = tools.filter((t) => t.name);
  if (!shown.length) return null;

  const rows = (
    <div className="cowork-tools">
      {shown.map((t) => (
        <details
          key={t.id}
          className={`cowork-tool status-${normalizeToolStatus(t.status)}`}
          // Collapsed by default — a successful edit/read/run shows only the
          // compact summary row; expand to see the diff/output. Only live
          // (running) and failed (error) calls open automatically.
          open={t.status === "running" || t.status === "error"}
        >
          <summary>
            <span className="cowork-tool-icon" aria-hidden>
              {toolIcon(t.name)}
            </span>
            <span className="cowork-tool-name">{t.name}</span>
            {t.summary && <span className="cowork-tool-summary">{t.summary}</span>}
            <span className="cowork-tool-status">{normalizeToolStatus(t.status)}</span>
            {(t.diff || t.output || t.error) && (
              <span className="cowork-tool-caret" aria-hidden>
                ▾
              </span>
            )}
          </summary>
          {t.error && <pre className="cowork-tool-error">{t.error}</pre>}
          {t.diff && <DiffBlock diff={t.diff} />}
          {t.output && !t.diff && <pre className="cowork-tool-out">{t.output.slice(0, 4000)}</pre>}
        </details>
      ))}
    </div>
  );

  // While the turn is still running, show the live list so progress is visible.
  if (streaming) return rows;

  // When finished, fold every tool call into ONE collapsed group so it doesn't
  // bury the answer. Auto-open only if something failed.
  const errors = shown.filter((t) => normalizeToolStatus(t.status) === "error").length;
  return (
    <details className="cowork-tools-group" open={errors > 0}>
      <summary>
        <span className="cowork-group-icon" aria-hidden>
          🔧
        </span>
        <span className="cowork-group-label">
          {shown.length} tool{shown.length === 1 ? "" : "s"} used
          {errors > 0 ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}
        </span>
        <span className="cowork-group-caret" aria-hidden>
          ▾
        </span>
      </summary>
      {rows}
    </details>
  );
}

function ApprovalBlock({
  approval,
  onApprove,
  onDeny,
  disabled,
}: {
  approval: ApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
  disabled: boolean;
}) {
  return (
    <div className={`approval-block ${approval.danger ? "danger" : ""}`}>
      <div className="approval-header">
        <span className="approval-icon">⚠️</span>
        <div className="approval-content">
          <div className="approval-title">Waiting for approval</div>
          <div className="approval-reason">
            {approval.title} — {approval.detail}
          </div>
        </div>
      </div>
      {approval.diff && (
        <div className="approval-diff">
          <DiffBlock diff={approval.diff} />
        </div>
      )}
      <div className="approval-actions">
        <button className="approval-deny" onClick={onDeny} disabled={disabled}>
          Deny
        </button>
        <button className="approval-approve" onClick={onApprove} disabled={disabled}>
          Approve
        </button>
      </div>
    </div>
  );
}

export function Chat() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [model, setModel] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [systemPrompt, setSystemPromptState] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [urlDraft, setUrlDraft] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [fetchingUrl, setFetchingUrl] = useState(false);
  /** Composer mode replaces the old Tools checkbox (ask / chat / agent). */
  const [mode, setMode] = useState<ComposerMode>("chat");
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  /** Conversation list pane — open by default on wide screens; drawer on narrow. */
  const [showConvos, setShowConvos] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filterProject, setFilterProject] = useState<string>("all"); // "all" | UNFILED | project id
  const [projectId, setProjectIdState] = useState<string | null>(null); // active conversation's project
  // Cowork Mode (folder agent) — separate from Spaces/projects-store.
  const [cowork, setCowork] = useState<CoworkProject | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [toolViews, setToolViews] = useState<ToolCallView[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [coworkPolicy, setCoworkPolicy] = useState<CoworkPolicy>("safe");
  const [maxToolCalls, setMaxToolCalls] = useState(0);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  /** Hits for command palette only — never overwrites sidebar search. */
  const [paletteHits, setPaletteHits] = useState<ConversationSearchHit[]>([]);
  const [paletteSearching, setPaletteSearching] = useState(false);
  const [convoSearch, setConvoSearch] = useState("");
  const [searchHits, setSearchHits] = useState<ConversationSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const [showScrollDown, setShowScrollDown] = useState(false);
  const [thinkingDot, setThinkingDot] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messagesRef = useRef<UiMessage[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const titleRef = useRef("");
  const modelRef = useRef("");
  const systemPromptRef = useRef("");
  const projectIdRef = useRef<string | null>(null);
  const createdAtRef = useRef(0);
  const reqRef = useRef<string | null>(null);
  const offRef = useRef<(() => void) | null>(null);
  const modeRef = useRef<ComposerMode>("chat");
  const policyRef = useRef<CoworkPolicy>("safe");
  const maxToolRef = useRef(0);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paletteSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Sync busy gate — React `busy` lags one frame; blocks double-Enter dual streams. */
  const busyRef = useRef(false);
  /** Serialize disk writes so an early send-save cannot overwrite a later finish-save. */
  const saveChainRef = useRef(Promise.resolve());
  /** Bumped on open/new so stale async openConversation results are ignored. */
  const openSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coworkRef = useRef<CoworkProject | null>(null);

  function setProjectId(v: string | null) {
    projectIdRef.current = v;
    setProjectIdState(v);
  }

  // Keep messagesRef in sync immediately (not only inside React's state updater).
  // Stream IPC callbacks + saveConvo() run outside React's batch; if the ref only
  // updated in setState, finishAndSave/send could persist a stale thread (missing
  // last delta, empty tool-only assistant rows still marked streaming, etc.).
  function setMsgs(updater: UiMessage[] | ((prev: UiMessage[]) => UiMessage[])) {
    const prev = messagesRef.current;
    const next = typeof updater === "function" ? updater(prev) : updater;
    messagesRef.current = next;
    setMessages(next);
  }

  function setSystemPrompt(v: string) {
    systemPromptRef.current = v;
    setSystemPromptState(v);
  }

  function setCoworkProject(p: CoworkProject | null, undo = false) {
    coworkRef.current = p;
    setCowork(p);
    setCanUndo(!!p && undo);
  }

  async function refreshCoworkState() {
    try {
      const s = await window.wan.cowork.state();
      setCoworkProject(s.project, s.canUndo);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    policyRef.current = coworkPolicy;
  }, [coworkPolicy]);

  useEffect(() => {
    maxToolRef.current = maxToolCalls;
  }, [maxToolCalls]);

  // Collapse conversation list into a drawer below ~960px (chat + app shell).
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 960px)");
    const apply = () => {
      const isNarrow = mq.matches;
      setNarrow(isNarrow);
      setShowConvos(!isNarrow);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    void api
      .getModels()
      .then((res) => {
        const enabled = res.models.filter((m) => m.enabled);
        setModels(enabled);
        setModel((cur) => cur || enabled[0]?.id || "");
      })
      .catch(() => {});
    void window.wan.convo.list().then((list) => {
      setConversations(list);
      if (list[0]) void openConversation(list[0].id);
    });
    void window.wan.project.list().then(setProjects).catch(() => {});
    void refreshCoworkState();
    void window.wan
      .getSettings()
      .then((s) => {
        if (s.coworkPolicy) setCoworkPolicy(s.coworkPolicy);
        if (typeof s.maxToolCalls === "number") setMaxToolCalls(s.maxToolCalls);
        if (s.chatComposerMode === "ask" || s.chatComposerMode === "chat" || s.chatComposerMode === "agent") {
          setMode(s.chatComposerMode);
          modeRef.current = s.chatComposerMode;
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced conversation search (sidebar only).
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = convoSearch.trim();
    if (q.length < 2) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimerRef.current = setTimeout(() => {
      void window.wan.convo
        .search(q, 30)
        .then(setSearchHits)
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false));
    }, 220);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [convoSearch]);

  // Debounced search inside command palette (isolated from sidebar).
  useEffect(() => {
    if (paletteSearchTimerRef.current) clearTimeout(paletteSearchTimerRef.current);
    if (!showPalette) {
      setPaletteHits([]);
      setPaletteSearching(false);
      return;
    }
    const q = paletteQuery.trim();
    if (q.length < 2) {
      setPaletteHits([]);
      setPaletteSearching(false);
      return;
    }
    setPaletteSearching(true);
    paletteSearchTimerRef.current = setTimeout(() => {
      void window.wan.convo
        .search(q, 30)
        .then(setPaletteHits)
        .catch(() => setPaletteHits([]))
        .finally(() => setPaletteSearching(false));
    }, 220);
    return () => {
      if (paletteSearchTimerRef.current) clearTimeout(paletteSearchTimerRef.current);
    };
  }, [paletteQuery, showPalette]);

  function closePalette() {
    setShowPalette(false);
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteHits([]);
    setPaletteSearching(false);
  }

  function openPalette() {
    setShowPalette(true);
    setPaletteQuery("");
    setPaletteIndex(0);
    setPaletteHits([]);
    requestAnimationFrame(() => paletteInputRef.current?.focus());
  }

  // Global chat shortcuts (palette, stop, approve, focus composer, …).
  useEffect(() => {
    const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

      // ⌘K toggles palette even while open (before the early-return).
      if (isMod(e) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (showPalette) closePalette();
        else openPalette();
        return;
      }

      if (showPalette) {
        if (e.key === "Escape") {
          e.preventDefault();
          closePalette();
        }
        return;
      }
      if (isMod(e) && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        newChat();
        return;
      }
      if (isMod(e) && (e.key === "." || e.key === "Escape") && busyRef.current) {
        e.preventDefault();
        stop();
        return;
      }
      if (e.key === "Escape" && busyRef.current && !inField) {
        e.preventDefault();
        stop();
        return;
      }
      if (isMod(e) && e.key === "/" && !e.shiftKey) {
        e.preventDefault();
        taRef.current?.focus();
        return;
      }
      if (isMod(e) && e.key === "ArrowUp" && !inField) {
        e.preventDefault();
        const lastUser = [...messagesRef.current].reverse().find((m) => m.role === "user");
        if (lastUser) editMessage(lastUser);
        return;
      }
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "a") {
        const top = approvals[0];
        if (top) {
          e.preventDefault();
          resolveApprovalUi(top.id, true);
        }
        return;
      }
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "r") {
        const top = approvals[0];
        if (top) {
          e.preventDefault();
          resolveApprovalUi(top.id, false);
        }
        return;
      }
      if (isMod(e) && e.key.toLowerCase() === "b" && !e.shiftKey) {
        e.preventDefault();
        setShowConvos((s) => !s);
        return;
      }
      if (isMod(e) && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        setShowContext((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPalette, approvals]);

  // Thinking dots animation — cycles while busy
  useEffect(() => {
    if (!busy) { setThinkingDot(0); return; }
    const t = setInterval(() => setThinkingDot((d) => (d + 1) % 3), 500);
    return () => clearInterval(t);
  }, [busy]);

  // Scroll-down button visibility
  const onScrollThread = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowScrollDown(!atBottom);
  }, []);

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only auto-scroll if already near bottom
    if (atBottom || busy) {
      el.scrollTop = el.scrollHeight;
      setShowScrollDown(false);
    }
  }, [messages, toolViews, approvals, busy]);

  // Abort in-flight stream on unmount so main doesn't keep running after leave.
  useEffect(
    () => () => {
      offRef.current?.();
      if (reqRef.current) void window.wan.chat.abort(reqRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  async function persistPolicy(next: CoworkPolicy) {
    setCoworkPolicy(next);
    policyRef.current = next;
    try {
      await window.wan.setSetting("coworkPolicy", next);
    } catch {
      /* best-effort */
    }
  }

  async function persistMaxTools(n: number) {
    const v = Math.max(0, Math.min(50, n | 0));
    setMaxToolCalls(v);
    maxToolRef.current = v;
    try {
      await window.wan.setSetting("maxToolCalls", v);
    } catch {
      /* best-effort */
    }
  }

  function applyMode(next: ComposerMode) {
    setMode(next);
    modeRef.current = next;
    void window.wan.setSetting("chatComposerMode", next).catch(() => {
      /* best-effort */
    });
    if (next === "agent" && !coworkRef.current) {
      toast.info("Open a project folder for Agent mode tools");
    }
  }

  function autoGrow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  /** Abort stream; mark any in-flight assistant row complete; optionally persist first. */
  function abortInFlight(opts?: { save?: boolean }) {
    const convoId = activeIdRef.current;
    const req = reqRef.current;
    offRef.current?.();
    offRef.current = null;
    if (req) {
      void window.wan.chat.abort(req);
      reqRef.current = null;
    }
    // Finalize streaming rows in the ref so a following save keeps partial text.
    const finalized = messagesRef.current.map((m) =>
      m.streaming ? { ...m, streaming: false } : m
    );
    messagesRef.current = finalized;
    setMessages(finalized);
    busyRef.current = false;
    setBusy(false);
    setToolStatus(null);
    setApprovals([]);
    if (opts?.save !== false && convoId) void saveConvo(convoId);
  }

  function saveConvo(id: string): Promise<void> {
    // Keep empty assistant turns that finished (tool-only / aborted) so history
    // still records that a reply happened; drop pure empty streaming stubs only
    // if they never got a role footprint — here we keep anything with content,
    // error, attachments, or a non-streaming assistant row.
    //
    // Writes are chained so an early send-save cannot finish after finishAndSave
    // and clobber the completed assistant turn on disk.
    const run = async () => {
      const records = messagesRef.current
        .filter((m) => m.content || m.error || m.attachments?.length || (m.role === "assistant" && !m.streaming))
        .map(toRecord);
      if (!records.length) return;
      const convo: Conversation = {
        id,
        title: titleRef.current || "New chat",
        model: modelRef.current,
        systemPrompt: systemPromptRef.current || undefined,
        projectId: projectIdRef.current || undefined,
        messages: records,
        createdAt: createdAtRef.current || Date.now(),
        updatedAt: Date.now(),
      };
      try {
        const summary = await window.wan.convo.save(convo);
        if (!createdAtRef.current) createdAtRef.current = summary.updatedAt;
        // Only refresh sidebar if this convo is still the one we think we saved
        // for (user may have switched; summary still valid for list).
        setConversations((list) => upsertSummary(list, summary));
      } catch {
        /* best-effort */
      }
    };
    const next = saveChainRef.current.then(run, run);
    saveChainRef.current = next.catch(() => {});
    return next;
  }

  async function openConversation(id: string): Promise<void> {
    if (id === activeIdRef.current) return;
    // Switching mid-stream: save partial reply, then abort so main stops.
    if (busyRef.current) abortInFlight({ save: true });
    const seq = ++openSeqRef.current;
    const c = await window.wan.convo.get(id);
    // Stale open (user clicked another chat / New while we were loading).
    if (seq !== openSeqRef.current) return;
    if (!c) return;
    offRef.current?.();
    offRef.current = null;
    activeIdRef.current = id;
    setActiveId(id);
    titleRef.current = c.title;
    setTitle(c.title);
    createdAtRef.current = c.createdAt;
    setSystemPrompt(c.systemPrompt ?? "");
    setProjectId(c.projectId ?? null);
    setShowSystem(false);
    setPendingAttachments([]);
    setContextItems([]);
    setShowUrl(false);
    setToolViews([]);
    setApprovals([]);
    setToolStatus(null);
    if (c.model) setModel(c.model);
    setMsgs(c.messages.map(fromRecord));
  }

  function newChat() {
    // Persist current thread (incl. partial assistant) before clearing the canvas.
    if (busyRef.current) abortInFlight({ save: true });
    else if (activeIdRef.current && messagesRef.current.length) void saveConvo(activeIdRef.current);
    openSeqRef.current += 1;
    offRef.current?.();
    offRef.current = null;
    activeIdRef.current = null;
    setActiveId(null);
    titleRef.current = "";
    setTitle("");
    createdAtRef.current = 0;
    setSystemPrompt("");
    setProjectId(null);
    setShowSystem(false);
    setPendingAttachments([]);
    setContextItems([]);
    setShowUrl(false);
    setInput("");
    setToolViews([]);
    setApprovals([]);
    setToolStatus(null);
    setMsgs([]);
    if (narrow) setShowConvos(false);
    requestAnimationFrame(autoGrow);
  }

  async function deleteConvo(id: string) {
    // Don't save a deleted conversation; just stop the stream.
    if (busyRef.current && id === activeIdRef.current) abortInFlight({ save: false });
    await window.wan.convo.delete(id);
    setConversations((list) => list.filter((c) => c.id !== id));
    if (id === activeIdRef.current) {
      openSeqRef.current += 1;
      activeIdRef.current = null;
      setActiveId(null);
      titleRef.current = "";
      setTitle("");
      createdAtRef.current = 0;
      setSystemPrompt("");
      setProjectId(null);
      setShowSystem(false);
      setPendingAttachments([]);
      setContextItems([]);
      setShowUrl(false);
      setInput("");
      setToolViews([]);
      setApprovals([]);
      setToolStatus(null);
      setMsgs([]);
    }
  }

  async function commitRename(id: string) {
    const next = renameText.trim();
    setRenamingId(null);
    if (!next) return;
    const summary = await window.wan.convo.rename(id, next);
    if (!summary) return;
    setConversations((list) => upsertSummary(list, summary));
    if (id === activeIdRef.current) {
      titleRef.current = next;
      setTitle(next);
    }
  }

  function ensureConvoId(): string {
    let id = activeIdRef.current;
    if (!id) {
      id = crypto.randomUUID();
      activeIdRef.current = id;
      setActiveId(id);
      createdAtRef.current = Date.now();
    }
    return id;
  }

  function buildApiMessages(history: UiMessage[]): { role: string; content: unknown }[] {
    const out: { role: string; content: unknown }[] = [];
    const sys = systemPromptRef.current.trim();
    if (sys) out.push({ role: "system", content: sys });
    for (const m of history) {
      if (m.role === "system") continue;
      out.push({ role: m.role, content: toApiContent(m) });
    }
    return out;
  }

  async function pickCoworkFolder() {
    try {
      const p = await window.wan.cowork.pick();
      if (p) {
        // pick clears last checkpoint on main — canUndo false until Checkpoint.
        setCoworkProject(p, false);
        toast.success(`Cowork: ${p.name}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open folder");
    }
  }

  async function clearCoworkFolder() {
    await window.wan.cowork.clear();
    setCoworkProject(null, false);
  }

  async function doCheckpoint() {
    if (!cowork || checkpointBusy) return;
    setCheckpointBusy(true);
    try {
      const r = await window.wan.cowork.checkpoint();
      if (r.ok) {
        setCanUndo(true);
        toast.success(r.error ? `Checkpoint (note: ${r.error})` : `Checkpoint ${r.id?.slice(0, 8) ?? "ok"}`);
      } else toast.error(r.error || "Checkpoint failed");
      await refreshCoworkState();
    } finally {
      setCheckpointBusy(false);
    }
  }

  async function doUndo() {
    if (!cowork || checkpointBusy || !canUndo) return;
    const msg = cowork.git
      ? "Reset project to the last Cowork git checkpoint? Uncommitted work may be lost."
      : "Restore files from the last Cowork snapshot (.wan/backups)? Later changes to snapshotted files will be overwritten.";
    if (!window.confirm(msg)) return;
    setCheckpointBusy(true);
    try {
      const r = await window.wan.cowork.undo();
      if (r.ok) toast.success("Restored last checkpoint");
      else toast.error(r.error || "Undo failed");
      await refreshCoworkState();
    } finally {
      setCheckpointBusy(false);
    }
  }

  function upsertToolView(view: ToolCallView) {
    setToolViews((list) => {
      const i = list.findIndex((t) => t.id === view.id);
      if (i < 0) return [...list, view];
      const next = list.slice();
      const merged = { ...next[i] };
      for (const [k, v] of Object.entries(view) as [keyof ToolCallView, ToolCallView[keyof ToolCallView]][]) {
        if (v !== undefined) (merged as Record<string, unknown>)[k as string] = v;
      }
      next[i] = merged;
      return next;
    });
  }

  function resolveApprovalUi(id: string, ok: boolean) {
    setApprovals((list) => list.filter((a) => a.id !== id));
    void (ok ? window.wan.chat.approve(id) : window.wan.chat.reject(id));
  }

  // Shared streaming core (send / regenerate). `history` is everything up to
  // and including the user turn we're answering; `aid` is the placeholder id.
  function streamInto(convoId: string, history: UiMessage[], aid: string, useModel: string) {
    // Tear down any previous listener before attaching a new one (safety net if
    // busyRef was forced false without finishing the prior stream).
    offRef.current?.();
    offRef.current = null;

    const reqId = crypto.randomUUID();
    reqRef.current = reqId;
    busyRef.current = true;
    setBusy(true);
    setToolViews([]);
    setApprovals([]);
    setToolStatus(null);

    const mergeTool = (list: ToolCallView[] | undefined, view: ToolCallView): ToolCallView[] => {
      const prev = list ?? [];
      const i = prev.findIndex((t) => t.id === view.id);
      if (i < 0) return [...prev, view];
      const next = prev.slice();
      // Prefer defined fields from the new event so later "ok" emits don't wipe
      // summary/diff/output that earlier patches already set.
      const merged = { ...next[i] };
      for (const [k, v] of Object.entries(view) as [keyof ToolCallView, ToolCallView[keyof ToolCallView]][]) {
        if (v !== undefined) (merged as Record<string, unknown>)[k as string] = v;
      }
      next[i] = merged;
      return next;
    };

    const isCurrent = () => reqRef.current === reqId;

    const finishAndSave = () => {
      if (!isCurrent()) return;
      busyRef.current = false;
      setBusy(false);
      setToolStatus(null);
      setApprovals([]);
      reqRef.current = null;
      offRef.current = null;
      // Main may have auto-checkpointed on first mutating tool — enable Undo.
      if (coworkRef.current) void refreshCoworkState();
      // Persist only if this conversation is still open (user may have switched).
      if (activeIdRef.current === convoId) void saveConvo(convoId);
    };

    const off = window.wan.chat.onStream((ev: ChatStreamEvent) => {
      if (ev.reqId !== reqId || !isCurrent()) return;
      if (ev.type === "delta") {
        setMsgs((m) => patch(m, aid, (x) => ({ ...x, content: x.content + ev.text })));
      } else if (ev.type === "usage") {
        setMsgs((m) => patch(m, aid, (x) => ({ ...x, usage: mapUsage(ev.usage, useModel) })));
      } else if (ev.type === "tool") {
        const status = normalizeToolStatus(ev.status);
        setToolStatus(status === "running" ? `Running ${ev.name}…` : null);
        const view: ToolCallView = ev.view
          ? { ...ev.view, status: normalizeToolStatus(ev.view.status ?? status) }
          : {
              id: `${ev.name}-${Date.now()}`,
              name: ev.name,
              args: {},
              status,
            };
        upsertToolView(view);
        setMsgs((m) => patch(m, aid, (x) => ({ ...x, tools: mergeTool(x.tools, view) })));
      } else if (ev.type === "approval") {
        setApprovals((list) => [...list.filter((a) => a.id !== ev.request.id), ev.request]);
      } else if (ev.type === "done" || ev.type === "aborted") {
        off();
        setMsgs((m) => patch(m, aid, (x) => ({ ...x, streaming: false })));
        finishAndSave();
      } else if (ev.type === "error") {
        off();
        setMsgs((m) => patch(m, aid, (x) => ({ ...x, streaming: false, error: ev.error })));
        finishAndSave();
        toast.error(ev.error);
      }
    });
    offRef.current = off;

    const m = modeRef.current;
    const hasFolder = !!coworkRef.current;
    // ask → no tools; chat → fetch_url; agent → cowork when folder selected.
    // Without a folder, agent falls back to chat tools (fetch_url) so the turn
    // still works; UI already surfaces "folder needed".
    const useTools = m !== "ask";
    const coworkOn = m === "agent" && hasFolder;
    if (m === "agent" && !hasFolder) {
      toast.info("Agent mode needs an open project folder — tools limited until then");
    }
    void window.wan.chat
      .start({
        reqId,
        model: useModel,
        messages: buildApiMessages(history),
        // Agent without folder → chat tools only (fetch_url); keep UI mode as Agent.
        mode: m === "agent" && !hasFolder ? "chat" : m,
        useTools,
        cowork: coworkOn,
        policy: policyRef.current,
        maxToolCalls: maxToolRef.current > 0 ? maxToolRef.current : undefined,
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        off();
        offRef.current = null;
        const msg = err instanceof Error ? err.message : String(err);
        setMsgs((list) => patch(list, aid, (x) => ({ ...x, streaming: false, error: msg })));
        finishAndSave();
        toast.error(msg || "Failed to start chat");
      });
  }

  async function send() {
    const text = input.trim();
    if ((!text && !pendingAttachments.length && !contextItems.length) || busyRef.current || !model) return;

    const id = ensureConvoId();
    if (!titleRef.current) {
      const t = makeTitle(text || contextItems[0]?.label || pendingAttachments[0]?.name || "Image");
      titleRef.current = t;
      setTitle(t);
    }

    // M5: fold any staged @-file / web-fetch context into the turn as a labelled
    // preamble so it travels with the message (and its history) verbatim.
    const content = buildContextPreamble(contextItems) + text;

    const aid = crypto.randomUUID();
    const userMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: Date.now(),
      attachments: pendingAttachments.length ? pendingAttachments : undefined,
    };
    const history = [...messagesRef.current, userMsg];

    setMsgs((m) => [
      ...m,
      userMsg,
      { id: aid, role: "assistant", content: "", model, createdAt: Date.now(), streaming: true },
    ]);
    setInput("");
    setPendingAttachments([]);
    setContextItems([]);
    setShowUrl(false);
    requestAnimationFrame(autoGrow);
    void saveConvo(id);
    streamInto(id, history, aid, model);
  }

  function regenerate() {
    if (busyRef.current) return;
    const msgs = messagesRef.current;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== "assistant") i--;
    if (i < 0) return;
    const history = msgs.slice(0, i); // drop the old assistant turn; keep its user turn
    const id = ensureConvoId();
    const aid = crypto.randomUUID();
    setMsgs([
      ...history,
      { id: aid, role: "assistant", content: "", model, createdAt: Date.now(), streaming: true },
    ]);
    streamInto(id, history, aid, model);
  }

  // Load a user turn back into the composer and truncate from there, so a
  // resend re-branches the conversation (§7).
  function editMessage(msg: UiMessage) {
    if (busyRef.current) return;
    const idx = messagesRef.current.findIndex((m) => m.id === msg.id);
    if (idx < 0) return;
    setInput(msg.content);
    setPendingAttachments(msg.attachments ?? []);
    setMsgs(messagesRef.current.slice(0, idx));
    // Persist truncated branch so a refresh doesn't revive dropped turns.
    if (activeIdRef.current) void saveConvo(activeIdRef.current);
    taRef.current?.focus();
    requestAnimationFrame(autoGrow);
  }

  function copyMessage(content: string, id: string) {
    void window.wan.copyText(content);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    setCopiedId(id);
    copiedTimerRef.current = setTimeout(() => setCopiedId(null), 1800);
  }

  // ── M5: context sources ───────────────────────────────────────────────────
  async function pickFileContext() {
    try {
      const files = await window.wan.context.pickFiles();
      if (!files.length) return;
      setContextItems((items) => [
        ...items,
        ...files.map((f) => ({ id: crypto.randomUUID(), kind: "file" as const, label: f.name, text: f.text, truncated: f.truncated })),
      ]);
    } catch {
      toast.error("Couldn't read the selected file(s)");
    }
  }

  async function addUrlContext() {
    const url = urlDraft.trim();
    if (!url || fetchingUrl) return;
    setFetchingUrl(true);
    try {
      const ctx = await window.wan.context.fetchUrl(url);
      setContextItems((items) => [
        ...items,
        { id: crypto.randomUUID(), kind: "url", label: ctx.title || ctx.url, text: ctx.text, truncated: ctx.truncated },
      ]);
      setUrlDraft("");
      setShowUrl(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setFetchingUrl(false);
    }
  }

  function removeContext(id: string) {
    setContextItems((items) => items.filter((c) => c.id !== id));
  }

  // ── M6: projects ──────────────────────────────────────────────────────────
  async function createProject() {
    const name = window.prompt("New project name")?.trim();
    if (!name) return;
    const p = await window.wan.project.create(name);
    setProjects((list) => [p, ...list]);
    setFilterProject(p.id);
  }

  async function assignProject(id: string | null) {
    setProjectId(id);
    if (activeIdRef.current) await saveConvo(activeIdRef.current);
  }

  function stop() {
    if (reqRef.current) void window.wan.chat.abort(reqRef.current);
  }

  async function addFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    if (!visionOn) {
      toast.error("This model has no vision support");
      return;
    }
    try {
      const added = await Promise.all(
        imgs.map(async (f) => ({ type: "image" as const, dataUrl: await readAsDataUrl(f), name: f.name }))
      );
      setPendingAttachments((a) => [...a, ...added]);
    } catch {
      toast.error("Couldn't read image");
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const currentModel = models.find((m) => m.id === model);
  const modelLabel = currentModel?.label ?? model;
  const visionOn = currentModel?.capabilities?.vision === true;
  const ctxWindow = contextWindowForFamily(currentModel?.family);
  const contextText = contextItems.map((c) => c.text).join("\n");
  const draftTokens = estimateTokens(
    `${systemPrompt}\n${messages.map((m) => m.content).join("\n")}\n${contextText}\n${input}`
  );
  const sessionTokens = messages.reduce((s, m) => s + (m.usage?.total ?? 0), 0);
  const sessionCost = messages.reduce((s, m) => s + (m.usage?.costUsd ?? 0), 0);
  const ctxWarn = draftTokens / ctxWindow > 0.9;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant" && !m.streaming)?.id;
  const canSend = !!(input.trim() || pendingAttachments.length || contextItems.length) && !!model;

  // M5: renderable artifacts across the whole thread (```html/```svg/```mermaid).
  const artifacts = extractArtifacts(messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
  // M6: sidebar filtered to the selected project bucket.
  const baseConversations = conversations.filter((c) =>
    filterProject === "all" ? true : filterProject === UNFILED ? !c.projectId : c.projectId === filterProject
  );
  // When search is active, show hits only (empty when 0 matches — don't fall back to full list).
  const searchActive = convoSearch.trim().length >= 2;
  const visibleConversations = searchActive
    ? searchHits.map(
        (h) =>
          conversations.find((c) => c.id === h.id) || {
            id: h.id,
            title: h.title,
            model: h.model,
            updatedAt: h.updatedAt,
            messageCount: 0,
            projectId: null as string | null,
          }
      )
    : baseConversations;

  type PaletteAction = { id: string; label: string; hint?: string; run: () => void };
  const paletteActions: PaletteAction[] = [
    { id: "new", label: "New chat", hint: "⌘N", run: () => newChat() },
    {
      id: "toggle-convos",
      label: showConvos ? "Hide conversations" : "Show conversations",
      hint: "⌘B",
      run: () => setShowConvos((s) => !s),
    },
    {
      id: "focus",
      label: "Focus composer",
      hint: "⌘/",
      run: () => taRef.current?.focus(),
    },
    {
      id: "context",
      label: showContext ? "Hide context inspector" : "Show context inspector",
      hint: "⌘⇧C",
      run: () => setShowContext((s) => !s),
    },
    {
      id: "mode-ask",
      label: "Mode: Ask (no tools)",
      run: () => applyMode("ask"),
    },
    {
      id: "mode-chat",
      label: "Mode: Chat",
      run: () => applyMode("chat"),
    },
    {
      id: "mode-agent",
      label: "Mode: Agent (Cowork)",
      run: () => applyMode("agent"),
    },
    {
      id: "folder",
      label: cowork ? "Change project folder" : "Open project folder",
      run: () => void pickCoworkFolder(),
    },
    ...(cowork
      ? [
          {
            id: "checkpoint",
            label: "Create checkpoint",
            run: () => void doCheckpoint(),
          },
          {
            id: "clear-folder",
            label: "Clear project folder",
            run: () => void clearCoworkFolder(),
          },
        ]
      : []),
    ...(busy
      ? [
          {
            id: "stop",
            label: "Stop generation",
            hint: "⌘.",
            run: () => stop(),
          },
        ]
      : []),
    ...(approvals[0]
      ? [
          {
            id: "approve",
            label: `Approve: ${approvals[0].title}`,
            hint: "⌘⇧A",
            run: () => resolveApprovalUi(approvals[0].id, true),
          },
          {
            id: "reject",
            label: `Reject: ${approvals[0].title}`,
            hint: "⌘⇧R",
            run: () => resolveApprovalUi(approvals[0].id, false),
          },
        ]
      : []),
    ...paletteHits.slice(0, 8).map((h) => ({
      id: `hit-${h.id}`,
      label: h.title,
      hint: h.snippet?.slice(0, 48) || h.model,
      run: () => {
        void openConversation(h.id);
        if (narrow) setShowConvos(false);
      },
    })),
  ];
  const pq = paletteQuery.trim().toLowerCase();
  const filteredPalette = pq
    ? paletteActions.filter(
        (a) => a.label.toLowerCase().includes(pq) || (a.hint && a.hint.toLowerCase().includes(pq))
      )
    : paletteActions;
  const safePaletteIndex = Math.min(paletteIndex, Math.max(0, filteredPalette.length - 1));

  function runPalette(i: number) {
    const a = filteredPalette[i];
    if (!a) return;
    closePalette();
    a.run();
  }
  const activeProjectName = projectId ? projects.find((p) => p.id === projectId)?.name ?? "Unfiled" : null;

  // Silence unused title lint while keeping title state for rename / future chrome.
  void title;

  function useStarter(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      autoGrow();
    });
  }

  return (
    <div className={`page chat-page copilot-chat ${narrow ? "chat-narrow" : ""} ${showConvos ? "convos-open" : "convos-closed"}`}>
      {/* Copilot-style slim top bar (no dashboard PageHeader) */}
      <header className="chat-topbar">
        <div className="chat-topbar-left">
          <button
            type="button"
            className={`chat-icon-btn chat-convos-toggle ${showConvos ? "on" : ""}`}
            onClick={() => setShowConvos((s) => !s)}
            title={showConvos ? "Hide conversations" : "Show conversations"}
            aria-expanded={showConvos}
            aria-controls="chat-convos-panel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          </button>
          <div className="chat-topbar-title">
            <span className="chat-topbar-brand">Copilot Chat</span>
            <span className="chat-topbar-sub">
              {title?.trim() || "New chat"}
              {modelLabel ? ` · ${modelLabel}` : ""}
            </span>
          </div>
        </div>
        <div className="chat-topbar-actions">
          <button
            type="button"
            className="chat-icon-btn"
            onClick={() => (showPalette ? closePalette() : openPalette())}
            title="Command palette (⌘K)"
          >
            <kbd className="chat-kbd">⌘K</kbd>
          </button>
          <button
            type="button"
            className={`chat-icon-btn ${showContext ? "on" : ""}`}
            onClick={() => setShowContext((s) => !s)}
            title="Context inspector (⌘⇧C)"
          >
            Context
          </button>
          {artifacts.length > 0 && (
            <button
              type="button"
              className={`chat-icon-btn chat-artifacts-toggle ${showArtifacts ? "on" : ""}`}
              onClick={() => setShowArtifacts((s) => !s)}
              title="Toggle artifacts panel"
            >
              Artifacts ({artifacts.length})
            </button>
          )}
          <button type="button" className="chat-icon-btn primary" onClick={newChat} disabled={busy} title="New chat (⌘N)">
            + New
          </button>
        </div>
      </header>

      {showPalette && (
        <div className="chat-palette-backdrop" onClick={() => closePalette()}>
          <div
            className="chat-palette"
            role="dialog"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={paletteInputRef}
              className="text-input chat-palette-input"
              placeholder="Search chats & commands…"
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value);
                setPaletteIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.min(i + 1, Math.max(0, filteredPalette.length - 1)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIndex((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  runPalette(safePaletteIndex);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closePalette();
                }
              }}
              autoFocus
            />
            <div className="chat-palette-list">
              {filteredPalette.length === 0 && (
                <div className="chat-palette-empty">
                  {paletteSearching ? "Searching…" : "No matches"}
                </div>
              )}
              {filteredPalette.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  className={`chat-palette-item ${i === safePaletteIndex ? "active" : ""}`}
                  onMouseEnter={() => setPaletteIndex(i)}
                  onClick={() => runPalette(i)}
                >
                  <span className="chat-palette-label">{a.label}</span>
                  {a.hint && <span className="chat-palette-hint">{a.hint}</span>}
                </button>
              ))}
            </div>
            <div className="chat-palette-foot">
              <span>↑↓ navigate</span>
              <span>↵ run</span>
              <span>esc close</span>
              <span>⌘N new · ⌘/ focus · ⌘. stop</span>
            </div>
          </div>
        </div>
      )}

      <div className={`chat-layout ${showArtifacts && artifacts.length > 0 ? "with-artifacts" : ""}`}>
        {narrow && showConvos && (
          <button
            type="button"
            className="chat-convos-backdrop"
            aria-label="Close conversation list"
            onClick={() => setShowConvos(false)}
          />
        )}
        <aside
          id="chat-convos-panel"
          className={`chat-convos ${showConvos ? "open" : "collapsed"}`}
          aria-hidden={!showConvos}
        >
          <div className="chat-convos-head">
            <span className="chat-convos-label">Chats</span>
            <button className="btn chat-new" onClick={newChat} disabled={busy}>
              + New
            </button>
            {narrow && (
              <button
                type="button"
                className="chat-convo-btn chat-convos-close"
                title="Close"
                onClick={() => setShowConvos(false)}
              >
                ✕
              </button>
            )}
          </div>

          <div className="chat-search-row">
            <input
              className="text-input chat-search-input"
              placeholder="Search chats…"
              value={convoSearch}
              onChange={(e) => setConvoSearch(e.target.value)}
              aria-label="Search conversations"
            />
            {convoSearch && (
              <button
                type="button"
                className="chat-convo-btn"
                title="Clear search"
                onClick={() => setConvoSearch("")}
              >
                ✕
              </button>
            )}
          </div>
          {convoSearch.trim().length >= 2 && (
            <div className="chat-search-meta">
              {searching ? "Searching…" : `${searchHits.length} hit${searchHits.length === 1 ? "" : "s"}`}
            </div>
          )}

          {/* M6: project / space filter. "All" and "Unfiled" are always present;
              projects follow, with a quick create action. */}
          <div className="chat-project-bar">
            <select
              className="text-input chat-project-select"
              value={filterProject}
              onChange={(e) => setFilterProject(e.target.value)}
            >
              <option value="all">All chats</option>
              <option value={UNFILED}>Unfiled</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="chat-convo-btn" title="New project" onClick={() => void createProject()}>
              ＋
            </button>
          </div>

          <div className="chat-convo-list">
            {visibleConversations.length === 0 && (
              <p className="page-hint" style={{ padding: "8px 6px" }}>
                {searchActive
                  ? searching
                    ? "Searching…"
                    : "No matching chats."
                  : "No conversations yet."}
              </p>
            )}
            {visibleConversations.map((c) => {
              const hit = searchHits.find((h) => h.id === c.id);
              return (
              <div key={c.id} className={`chat-convo-row ${c.id === activeId ? "active" : ""}`}>
                {renamingId === c.id ? (
                  <input
                    className="text-input chat-rename-input"
                    value={renameText}
                    autoFocus
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(c.id);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void commitRename(c.id)}
                  />
                ) : (
                  <button
                    className="chat-convo-open"
                    onClick={() => {
                      void openConversation(c.id);
                      if (narrow) setShowConvos(false);
                    }}
                    title={hit?.snippet || c.title}
                  >
                    <span className="chat-convo-title">{c.title}</span>
                    <span className="chat-convo-meta">
                      {hit ? hit.snippet.slice(0, 42) : `${c.messageCount ?? 0} msg`}
                    </span>
                  </button>
                )}
                <div className="chat-convo-actions">
                  <button
                    className="chat-convo-btn"
                    title="Rename"
                    onClick={() => {
                      setRenamingId(c.id);
                      setRenameText(c.title);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="chat-convo-btn"
                    title="Delete"
                    disabled={busy && c.id === activeId}
                    onClick={() => void deleteConvo(c.id)}
                  >
                    🗑
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        </aside>

        <div className="chat-main">
          {/* Compact workspace strip — Copilot-style secondary chrome */}
          <div className={`cowork-bar copilot-workspace ${cowork ? "on" : ""}`}>
            {cowork ? (
              <>
                <span className="cowork-badge" title={cowork.root}>
                  <span className="cowork-folder-ico" aria-hidden>📁</span>
                  {cowork.name}
                  {cowork.git ? " · git" : ""}
                </span>
                <span className="cowork-path" title={cowork.root}>
                  {shortenPath(cowork.root, 2)}
                </span>
                <div className="cowork-bar-actions">
                  <select
                    className="text-input cowork-policy-select"
                    value={coworkPolicy}
                    disabled={busy}
                    title={POLICY_META[coworkPolicy].hint}
                    onChange={(e) => void persistPolicy(e.target.value as CoworkPolicy)}
                  >
                    {(Object.keys(POLICY_META) as CoworkPolicy[]).map((p) => (
                      <option key={p} value={p}>
                        {POLICY_META[p].label}
                      </option>
                    ))}
                  </select>
                  <label className="cowork-budget" title="Max tool calls per turn (0 = built-in default)">
                    <span>Tools</span>
                    <input
                      className="text-input cowork-budget-input"
                      type="number"
                      min={0}
                      max={50}
                      value={maxToolCalls}
                      disabled={busy}
                      onChange={(e) => void persistMaxTools(Number(e.target.value) || 0)}
                    />
                  </label>
                  <button
                    className="btn secondary cowork-btn"
                    disabled={checkpointBusy || busy}
                    onClick={() => void doCheckpoint()}
                    title={cowork.git ? "Git commit checkpoint before risky edits" : "Snapshot files to .wan/backups for Undo"}
                  >
                    {narrow ? "Save" : "Checkpoint"}
                  </button>
                  <button
                    className="btn secondary cowork-btn"
                    disabled={checkpointBusy || busy || !canUndo}
                    onClick={() => void doUndo()}
                    title={
                      !canUndo
                        ? "No checkpoint yet — click Checkpoint first"
                        : cowork.git
                          ? "git reset --hard to last checkpoint"
                          : "Restore last .wan/backups snapshot"
                    }
                  >
                    Undo
                  </button>
                  <details className="cowork-more">
                    <summary className="btn secondary cowork-btn" title="More">
                      ⋯
                    </summary>
                    <div className="cowork-more-menu">
                      <button
                        disabled={busy}
                        onClick={(e) => {
                          e.currentTarget.closest("details")?.removeAttribute("open");
                          void pickCoworkFolder();
                        }}
                      >
                        Change folder…
                      </button>
                      <button
                        disabled={busy}
                        onClick={(e) => {
                          e.currentTarget.closest("details")?.removeAttribute("open");
                          void clearCoworkFolder();
                        }}
                      >
                        Clear folder
                      </button>
                    </div>
                  </details>
                </div>
              </>
            ) : (
              <>
                <span className="cowork-hint">
                  {mode === "agent"
                    ? "Agent needs a workspace folder for tools."
                    : "Optional workspace for Agent tools."}
                </span>
                <button className="btn secondary cowork-btn" onClick={() => void pickCoworkFolder()}>
                  Open folder
                </button>
              </>
            )}
          </div>

          {showContext && (
            <div className="chat-context-inspector">
              <div className="chat-context-inspector-head">
                <strong>Context inspector</strong>
                <button type="button" className="chat-convo-btn" onClick={() => setShowContext(false)} title="Close">
                  ✕
                </button>
              </div>
              <div className="chat-context-inspector-meter">
                <span className={ctxWarn ? "warn" : ""}>
                  ≈ {formatCompactNumber(draftTokens)} / {formatCompactNumber(ctxWindow)} tok
                </span>
                <span>{MODE_META[mode].label} · {POLICY_META[coworkPolicy].label}</span>
              </div>
              <div className="chat-context-inspector-section">
                <div className="chat-context-inspector-label">System prompt</div>
                <pre className="chat-context-inspector-pre">
                  {systemPrompt.trim() || "(empty)"}
                </pre>
              </div>
              <div className="chat-context-inspector-section">
                <div className="chat-context-inspector-label">
                  Staged context ({contextItems.length})
                </div>
                {contextItems.length === 0 ? (
                  <p className="page-hint">No @file / URL chips staged.</p>
                ) : (
                  <ul className="chat-context-inspector-list">
                    {contextItems.map((c) => (
                      <li key={c.id}>
                        <span>
                          {c.kind === "file" ? "📄" : "🔗"} {c.label}
                          {c.truncated ? " (truncated)" : ""} · {formatCompactNumber(estimateTokens(c.text))} tok
                        </span>
                        <button type="button" className="chat-convo-btn" onClick={() => removeContext(c.id)}>
                          strip
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {contextItems.length > 0 && (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => setContextItems([])}
                    style={{ marginTop: 6 }}
                  >
                    Clear all context
                  </button>
                )}
              </div>
              <div className="chat-context-inspector-section">
                <div className="chat-context-inspector-label">Composer draft</div>
                <pre className="chat-context-inspector-pre">
                  {input.trim() ? input.slice(0, 400) + (input.length > 400 ? "…" : "") : "(empty)"}
                </pre>
              </div>
            </div>
          )}

          <div className="chat-thread" ref={scrollRef} onScroll={onScrollThread}>
            {!messages.length && (
              <div className="chat-empty copilot-empty">
                <div className="copilot-empty-mark" aria-hidden>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3 4.5 7v5c0 4.4 3.1 8.5 7.5 9.5 4.4-1 7.5-5.1 7.5-9.5V7L12 3Z" />
                    <path d="M9 12h6" />
                    <path d="M12 9v6" />
                  </svg>
                </div>
                <h2 className="copilot-empty-title">
                  {cowork ? `Ready in ${cowork.name}` : "Hi, I'm your coding assistant"}
                </h2>
                <p className="copilot-empty-sub">
                  {cowork
                    ? "Ask about structure, edits, tests, or shell commands. Use Checkpoint before risky changes."
                    : `Chat with ${modelLabel || "your model"} through local CLIProxyAPI accounts.`}
                </p>
                <div className="copilot-starters" aria-label="Suggested prompts">
                  {STARTER_PROMPTS.map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      className="copilot-starter"
                      disabled={!model}
                      onClick={() => useStarter(s.text)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="chat-cheatsheet" aria-label="Keyboard shortcuts">
                  <span><kbd>⌘K</kbd> commands</span>
                  <span><kbd>⌘N</kbd> new</span>
                  <span><kbd>⌘/</kbd> focus</span>
                  <span><kbd>⌘.</kbd> stop</span>
                </div>
              </div>
            )}

            {messages.map((m, msgIdx) => (
              <div key={m.id} className={`chat-msg ${m.role}`} style={{ animationDelay: `${Math.min(msgIdx * 0.04, 0.3)}s` }}>
                <div className="chat-avatar" aria-hidden>
                  {m.role === "user" ? (
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="3.4" />
                      <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3 4.5 7v5c0 4.4 3.1 8.5 7.5 9.5 4.4-1 7.5-5.1 7.5-9.5V7L12 3Z" />
                    </svg>
                  )}
                </div>
                <div className="chat-msg-body">
                  <div className="chat-msg-role">
                    <span className="chat-msg-role-label">{m.role === "user" ? "You" : "Copilot"}</span>
                    <span className="chat-msg-time" title={new Date(m.createdAt).toLocaleString()}>
                      {formatRelativeTime(m.createdAt)}
                    </span>
                  </div>
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="chat-msg-atts">
                      {m.attachments.map((a, i) => (
                        <img key={i} src={a.dataUrl} alt={a.name ?? "image"} className="chat-msg-img" />
                      ))}
                    </div>
                  )}
                  <div className="chat-msg-content">
                    {m.role === "assistant" ? (
                      m.content ? <ChatMarkdown content={m.content} /> : m.streaming ? (
                        <span className="chat-thinking">
                          <span className="chat-thinking-dot" style={{ opacity: thinkingDot === 0 ? 1 : 0.3 }}>●</span>
                          <span className="chat-thinking-dot" style={{ opacity: thinkingDot === 1 ? 1 : 0.3 }}>●</span>
                          <span className="chat-thinking-dot" style={{ opacity: thinkingDot === 2 ? 1 : 0.3 }}>●</span>
                        </span>
                      ) : null
                    ) : (
                      <div className="chat-bubble">{m.content}</div>
                    )}
                    {m.error && <span className="chat-error">{m.error}</span>}
                  </div>

                  {/* Tool timeline — keep after stream ends so diffs/output remain visible this session */}
                  {m.role === "assistant" && (m.tools?.length || (m.streaming && toolViews.length > 0)) ? (
                    <ToolTimeline tools={m.tools?.length ? m.tools : toolViews} streaming={m.streaming} />
                  ) : null}

                  {/* Approval blocks — only under the active (streaming) turn,
                      never duplicated onto earlier finished assistant messages. */}
                  {m.role === "assistant" && m.streaming && approvals.length > 0 && (
                    <div>
                      {approvals.map((approval) => (
                        <ApprovalBlock
                          key={approval.id}
                          approval={approval}
                          onApprove={() => resolveApprovalUi(approval.id, true)}
                          onDeny={() => resolveApprovalUi(approval.id, false)}
                          // Never disabled: the turn is intentionally "running"
                          // while it waits for this decision, so the buttons must
                          // stay clickable.
                          disabled={false}
                        />
                      ))}
                    </div>
                  )}

                  <div className="chat-msg-foot">
                    {m.usage && (
                      <span className="chat-usage">
                        {compact(m.usage.input)} in · {compact(m.usage.output)} out · ~{formatUsd(m.usage.costUsd)}
                      </span>
                    )}
                    {!m.streaming && (
                      <span className="chat-msg-actions">
                        {m.content && (
                          <button className="chat-msg-act" onClick={() => copyMessage(m.content, m.id)}>
                            {copiedId === m.id ? (
                              <><span className="chat-act-icon">✓</span> Copied</>
                            ) : (
                              <><span className="chat-act-icon">⎘</span> Copy</>
                            )}
                          </button>
                        )}
                        {m.role === "user" && (
                          <button className="chat-msg-act" onClick={() => editMessage(m)} disabled={busy}>
                            <span className="chat-act-icon">✎</span> Edit
                          </button>
                        )}
                        {m.role === "assistant" && m.id === lastAssistantId && (
                          <button className="chat-msg-act" onClick={regenerate} disabled={busy}>
                            <span className="chat-act-icon">↺</span> Regenerate
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {/* Jump to bottom — fixed inside thread so position:absolute anchors correctly */}
            {showScrollDown && (
              <button
                type="button"
                className="chat-scroll-down"
                onClick={scrollToBottom}
                title="Jump to latest"
              >
                ↓
              </button>
            )}
          </div>

          {pendingAttachments.length > 0 && (
            <div className="chat-pending">
              {pendingAttachments.map((a, i) => (
                <div key={i} className="chat-pending-item">
                  <img src={a.dataUrl} alt={a.name ?? "image"} />
                  <button
                    className="chat-pending-x"
                    title="Remove"
                    onClick={() => setPendingAttachments((list) => list.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* M5: staged @-file / web-fetch context, removable before send. */}
          {contextItems.length > 0 && (
            <div className="chat-context-chips">
              {contextItems.map((c) => (
                <span key={c.id} className="chat-context-chip" title={`${c.text.length} chars${c.truncated ? " (truncated)" : ""}`}>
                  <span className="chat-context-kind">{c.kind === "file" ? "📄" : "🔗"}</span>
                  <span className="chat-context-label">{c.label}</span>
                  <button className="chat-context-x" title="Remove" onClick={() => removeContext(c.id)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* M5: web-fetch URL entry (toggled from the composer link button). */}
          {showUrl && (
            <div className="chat-url-row">
              <input
                className="text-input chat-url-input"
                placeholder="https://… — fetched by the app and added as context"
                value={urlDraft}
                autoFocus
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addUrlContext();
                  if (e.key === "Escape") setShowUrl(false);
                }}
              />
              <button className="btn secondary" onClick={() => void addUrlContext()} disabled={!urlDraft.trim() || fetchingUrl}>
                {fetchingUrl ? "Fetching…" : "Add"}
              </button>
            </div>
          )}

          <div className="chat-composer-dock">
            <div className="chat-status copilot-status">
              <div className="chat-status-left">
                <span className={`chat-meter ${ctxWarn ? "warn" : ""}`} title="Estimated context usage">
                  ≈ {formatCompactNumber(draftTokens)} / {formatCompactNumber(ctxWindow)}
                </span>
                {mode === "agent" && !cowork && (
                  <span className="chat-status-chip warn-chip" title="Open a folder for Agent tools">
                    folder needed
                  </span>
                )}
                {toolStatus && <span className="chat-tool-status">⚙ {toolStatus}</span>}
              </div>
              <div className="chat-status-right">
                {cowork && <span className="chat-cowork-status">{cowork.name}</span>}
                {activeProjectName && <span className="chat-active-project">{activeProjectName}</span>}
                {sessionTokens > 0 && (
                  <span className="chat-session" title="Session usage">
                    {formatCompactNumber(sessionTokens)} tok · ~{formatUsd(sessionCost)}
                  </span>
                )}
              </div>
            </div>

            <div
              className="chat-composer copilot-composer"
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="chat-composer-modes" role="group" aria-label="Composer mode">
                {(Object.keys(MODE_META) as ComposerMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chat-mode-btn ${mode === m ? "active" : ""}`}
                    title={MODE_META[m].hint}
                    disabled={busy}
                    onClick={() => applyMode(m)}
                  >
                    {MODE_META[m].label}
                  </button>
                ))}
              </div>
              <textarea
                ref={taRef}
                className="text-input chat-input"
                value={input}
                placeholder={
                  model
                    ? mode === "agent"
                      ? "Ask Copilot to edit, run, or explore…"
                      : "Ask Copilot anything…"
                    : "Enable a model on the Models page first"
                }
                onChange={(e) => {
                  setInput(e.target.value);
                  autoGrow();
                }}
                onKeyDown={onKeyDown}
                onPaste={(e) => {
                  if (e.clipboardData?.files?.length) void addFiles(e.clipboardData.files);
                }}
                rows={1}
                disabled={!model}
              />
              <div className="chat-composer-bar">
                <div className="chat-composer-left">
                  {visionOn && (
                    <button className="btn secondary chat-attach-btn" title="Attach image" onClick={() => fileRef.current?.click()}>
                      📎
                    </button>
                  )}
                  <button className="btn secondary chat-attach-btn" title="Add file as context" onClick={() => void pickFileContext()}>
                    @
                  </button>
                  <button
                    className={`btn secondary chat-attach-btn ${showUrl ? "on" : ""}`}
                    title="Add a web page as context"
                    onClick={() => setShowUrl((s) => !s)}
                  >
                    🔗
                  </button>
                  {mode === "agent" && (
                    <select
                      className="text-input chat-policy-inline"
                      value={coworkPolicy}
                      disabled={busy}
                      title={POLICY_META[coworkPolicy].hint}
                      onChange={(e) => void persistPolicy(e.target.value as CoworkPolicy)}
                    >
                      {(Object.keys(POLICY_META) as CoworkPolicy[]).map((p) => (
                        <option key={p} value={p}>
                          {POLICY_META[p].label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="chat-composer-right">
                  <ModelPicker models={models} value={model} onChange={setModel} up />
                  {busy ? (
                    <button className="btn danger chat-send copilot-send" onClick={stop} title="Stop (⌘.)">
                      Stop
                    </button>
                  ) : (
                    <button
                      className="btn chat-send copilot-send"
                      onClick={() => void send()}
                      disabled={!canSend}
                      title="Send (Enter)"
                      aria-label="Send"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M5 12h14" />
                        <path d="m13 6 6 6-6 6" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>

            {showSystem && (
              <textarea
                className="text-input chat-system-input"
                placeholder="Optional persona / instructions for this conversation…"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                onBlur={() => activeIdRef.current && void saveConvo(activeIdRef.current)}
                rows={3}
              />
            )}
            <div className="chat-system-bar copilot-system-bar">
              <button className={`chat-system-toggle ${systemPrompt ? "set" : ""}`} onClick={() => setShowSystem((s) => !s)}>
                {systemPrompt ? "● Instructions" : "○ Instructions"}
              </button>
              <select
                className="text-input chat-assign-select"
                value={projectId ?? ""}
                onChange={(e) => void assignProject(e.target.value || null)}
                title="Assign this conversation to a project"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {(mode === "chat" || mode === "agent") && (
                <label className="cowork-budget chat-budget-inline" title="Max tool calls per turn (0 = default)">
                  <span>Tools</span>
                  <input
                    className="text-input cowork-budget-input"
                    type="number"
                    min={0}
                    max={50}
                    value={maxToolCalls}
                    disabled={busy}
                    onChange={(e) => void persistMaxTools(Number(e.target.value) || 0)}
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        {showArtifacts && artifacts.length > 0 && (
          <ArtifactsPanel artifacts={artifacts} onClose={() => setShowArtifacts(false)} />
        )}
      </div>
    </div>
  );
}
