import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type { ToolCallView } from "./cowork-types.js";

// In-app Chat history (HANDBOOK M2 — "Riwayat"). Conversations live as plain
// JSON in userData/conversations/: one <id>.json per conversation (full
// content) plus a single index.json (lightweight summaries for the sidebar).
// Same pattern as app-settings.ts — no electron-store, shape is small/stable.
// Writes are atomic (.tmp → rename) so a quit mid-save can't corrupt a file
// (HANDBOOK Jebakan #12).

export interface ChatAttachment {
  type: "image";
  dataUrl: string; // base64 data URL (persisted with the conversation)
  name?: string;
}

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant" | "system";
  content: string; // raw markdown
  model?: string; // model that answered (assistant turns)
  createdAt: number; // epoch ms
  usage?: { input: number; output: number; total: number; costUsd?: number };
  attachments?: ChatAttachment[]; // vision inputs on user turns (HANDBOOK M4)
  error?: string;
  tools?: ToolCallView[]; // persisted Cowork tool timeline (survives restart)
}

export interface Conversation {
  id: string;
  title: string;
  model: string; // active model for the conversation
  systemPrompt?: string; // per-conversation persona (M4)
  projectId?: string; // owning project / space (M6), undefined = Unfiled
  messages: ChatMessageRecord[];
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  projectId?: string; // mirrored into the index so the sidebar can group cheaply
  updatedAt: number;
  messageCount: number;
}

function convoDir(): string {
  return path.join(app.getPath("userData"), "conversations");
}
function indexPath(): string {
  return path.join(convoDir(), "index.json");
}
function filePath(id: string): string {
  return path.join(convoDir(), `${id}.json`);
}

// Only [a-z0-9-] ids ever reach the filesystem — reject anything else so a
// crafted id can't escape convoDir via path traversal.
function safeId(id: unknown): string | null {
  return typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id) ? id : null;
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

function summarize(c: Conversation): ConversationSummary {
  return {
    id: c.id,
    title: c.title,
    model: c.model,
    projectId: c.projectId,
    updatedAt: c.updatedAt,
    // Exclude the reserved system message from the visible count.
    messageCount: c.messages.filter((m) => m.role !== "system").length,
  };
}

function readIndex(): ConversationSummary[] {
  try {
    const raw = fs.readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConversationSummary[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(list: ConversationSummary[]): void {
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  writeAtomic(indexPath(), JSON.stringify(list, null, 2));
}

/** Sidebar source — newest first. Cheap: reads index.json only. */
export function listConversations(): ConversationSummary[] {
  const list = readIndex();
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Full conversation, or null if the id is unknown/invalid. */
export function getConversation(id: string): Conversation | null {
  const clean = safeId(id);
  if (!clean) return null;
  try {
    const raw = fs.readFileSync(filePath(clean), "utf8");
    return JSON.parse(raw) as Conversation;
  } catch {
    return null;
  }
}

/**
 * Persist a conversation and refresh its index entry. The renderer owns id
 * generation and content; this just stamps updatedAt and keeps index.json in
 * sync. Debounced on the renderer side so streaming doesn't write per-token
 * (HANDBOOK Jebakan #6).
 */
export function saveConversation(input: Conversation): ConversationSummary {
  const clean = safeId(input.id);
  if (!clean) throw new Error("invalid conversation id");
  const now = Date.now();
  const convo: Conversation = {
    ...input,
    id: clean,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  writeAtomic(filePath(clean), JSON.stringify(convo, null, 2));

  const summary = summarize(convo);
  const index = readIndex().filter((s) => s.id !== clean);
  index.push(summary);
  writeIndex(index);
  return summary;
}

/** Remove a conversation file and its index entry. Idempotent. */
export function deleteConversation(id: string): void {
  const clean = safeId(id);
  if (!clean) return;
  try {
    fs.rmSync(filePath(clean), { force: true });
  } catch {
    /* already gone */
  }
  writeIndex(readIndex().filter((s) => s.id !== clean));
}

/** Rename in both the file and the index. Returns the updated summary. */
export function renameConversation(id: string, title: string): ConversationSummary | null {
  const convo = getConversation(id);
  if (!convo) return null;
  convo.title = title.trim() || convo.title;
  return saveConversation(convo);
}

/** Full-text-ish search over conversation titles + message bodies (MVP scan). */
export interface ConversationSearchHit {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
  snippet: string;
  messageId?: string;
}

export function searchConversations(query: string, limit = 40): ConversationSearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: ConversationSearchHit[] = [];
  const max = Math.max(1, Math.min(100, limit | 0));

  for (const s of listConversations()) {
    if (hits.length >= max) break;
    const titleHit = s.title.toLowerCase().includes(q);
    if (titleHit) {
      hits.push({
        id: s.id,
        title: s.title,
        model: s.model,
        updatedAt: s.updatedAt,
        snippet: s.title,
      });
      continue;
    }

    const c = getConversation(s.id);
    if (!c) continue;
    for (const m of c.messages) {
      if (m.role === "system" || !m.content) continue;
      const idx = m.content.toLowerCase().indexOf(q);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 48);
      const end = Math.min(m.content.length, idx + q.length + 72);
      let snip = m.content.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snip = `…${snip}`;
      if (end < m.content.length) snip = `${snip}…`;
      hits.push({
        id: c.id,
        title: c.title,
        model: c.model,
        updatedAt: c.updatedAt,
        snippet: snip,
        messageId: m.id,
      });
      break;
    }
  }
  return hits;
}
