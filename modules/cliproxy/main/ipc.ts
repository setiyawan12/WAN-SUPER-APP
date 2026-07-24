import { ipcMain, clipboard, BrowserWindow } from "electron";
import { backendUrl, backendPort } from "./config.js";
import { getSettings, setSetting, type AppSettings } from "./app-settings.js";
import {
  syncNow,
  copyApiKey,
  openExternal,
  getVsCodeState,
  refreshHealth,
  getLastHealth,
  scheduleSync,
} from "./vscode-sync.js";
import { getMainWindow } from "./events.js";
import { syncJetBrainsNow, getJetBrainsState } from "./jetbrains-sync.js";
import { startChat, abortChat, type ChatStartPayload } from "./chat-service.js";
import {
  listConversations,
  getConversation,
  saveConversation,
  deleteConversation,
  renameConversation,
  searchConversations,
  type Conversation,
} from "./chat-store.js";
import { pickContextFiles, fetchUrlContext } from "./context-service.js";
import { listProjects, createProject, updateProject, deleteProject } from "./projects-store.js";
import { hideQuickChat } from "./quick-chat.js";
import { resolveApproval } from "./approvals.js";
import {
  pickCoworkProject,
  setCoworkRoot,
  getCoworkState,
  clearCoworkProject,
  createCheckpoint,
  undoCheckpoint,
} from "./cowork-project.js";

export interface WanRequest {
  method?: string;
  path: string; // e.g. "/models" -- prefixed with /api by the bridge
  body?: string; // already-serialized (JSON string or raw YAML text)
  contentType?: string; // defaults to application/json
}

export interface WanResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

/**
 * The single generic bridge that replaces the extension's webview<->HTTP+CORS
 * transport. The renderer's api/client.ts calls window.wan.request(); this
 * forwards to the in-process backend over loopback. Because the ONLY caller is
 * the main process itself (no browser Origin header), the backend's CORS gate
 * lets it through, and the renderer never touches HTTP directly -- so the
 * open-dashboard-API attack surface the handbook (§12) warns about is gone.
 */
// Upper bound for a single backend round-trip over the bridge. Generous enough
// for a slow model list / install probe, short enough that a wedged backend
// surfaces as an error instead of a frozen UI.
const REQUEST_TIMEOUT_MS = 20_000;

async function handleRequest(_e: unknown, req: WanRequest): Promise<WanResponse> {
  const method = (req.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (req.body !== undefined && method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = req.contentType || "application/json";
    body = req.body;
  }

  // Bound the call so a hung backend (e.g. CLIProxyAPI stuck mid-request)
  // can't leave the renderer's await pending forever. On timeout/refusal we
  // return a well-formed error WanResponse instead of rejecting the IPC call,
  // so api/client.ts surfaces a clean toast rather than an unhandled rejection.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${backendUrl()}/api${req.path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();

    // Handbook Tahap 7.3: a model toggle should re-sync VS Code. The dashboard
    // saves enabled models via PUT /models, so piggyback a debounced sync here.
    if (res.ok && method === "PUT" && req.path.startsWith("/models")) {
      scheduleSync();
    }

    return { ok: res.ok, status: res.status, statusText: res.statusText, text };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      status: 0,
      statusText: aborted ? "Request timed out" : "Backend unreachable",
      text: aborted
        ? `The internal server did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function registerIpc(): void {
  ipcMain.handle("wan:request", handleRequest);

  // Desktop-only channels (no HTTP equivalent).
  ipcMain.handle("wan:syncNow", () => syncNow(true));
  ipcMain.handle("wan:copyApiKey", () => copyApiKey());
  ipcMain.handle("wan:openExternal", (_e, url: string) => openExternal(url));
  ipcMain.handle("wan:vscodeState", () => getVsCodeState());
  ipcMain.handle("wan:backendInfo", () => ({
    port: backendPort(),
    proxyUrl: `${backendUrl()}/api/proxy/v1/chat/completions`,
  }));
  ipcMain.handle("wan:copyText", (_e, text: string) => clipboard.writeText(text));

  // JetBrains / ProxyAI direct-inject ("Jalur B"). No HTTP equivalent -- writes
  // the plugin's CodeGPT_CustomServicesSettings.xml directly. Separate from the
  // VS Code sync above because JetBrains has no live file watcher.
  ipcMain.handle("wan:jetbrainsSync", () => syncJetBrainsNow(true));
  ipcMain.handle("wan:jetbrainsState", () => getJetBrainsState());
  ipcMain.handle("wan:health", async () => {
    await refreshHealth();
    return getLastHealth();
  });

  ipcMain.handle("wan:getSettings", () => getSettings());
  ipcMain.handle("wan:setSetting", (_e, key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => {
    const next = setSetting(key, value as never);
    // Re-sync immediately if the sync-relevant toggles changed.
    if (key === "requireApiKey" || key === "autoSyncVsCode") void syncNow(false);
    return next;
  });

  // In-app Chat (HANDBOOK M1). start is fire-and-forget: the reply streams back
  // as "wan:event"/type:"chat" events, not as this invoke's return value.
  ipcMain.handle("chat:start", (_e, p: ChatStartPayload) => {
    void startChat(p);
  });
  ipcMain.handle("chat:abort", (_e, reqId: string) => abortChat(reqId));
  // Cowork write/run approvals (HANDBOOK COWORK §8 / §13).
  ipcMain.handle("chat:approve", (_e, id: string) => resolveApproval(id, true));
  ipcMain.handle("chat:reject", (_e, id: string) => resolveApproval(id, false));

  // Conversation history (HANDBOOK M2). Plain CRUD over userData/conversations/.
  ipcMain.handle("convo:list", () => listConversations());
  ipcMain.handle("convo:get", (_e, id: string) => getConversation(id));
  ipcMain.handle("convo:save", (_e, convo: Conversation) => saveConversation(convo));
  ipcMain.handle("convo:delete", (_e, id: string) => deleteConversation(id));
  ipcMain.handle("convo:rename", (_e, id: string, title: string) => renameConversation(id, title));
  ipcMain.handle("convo:search", (_e, query: string, limit?: number) => searchConversations(query, limit));

  // Chat context sources (HANDBOOK M5). File picking is anchored to the window
  // that asked, so the native dialog attaches to the right surface (dashboard
  // vs quick-chat). Both return plain text the renderer splices into the turn.
  ipcMain.handle("context:pickFiles", (e) => pickContextFiles(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle("context:fetchUrl", (_e, url: string) => fetchUrlContext(url));

  // Projects / Spaces (HANDBOOK M6). Group conversations by project id.
  // Named "space:*" would be clearer vs Cowork folders, but keep "project:*"
  // for backward compatibility with the existing renderer bridge.
  ipcMain.handle("project:list", () => listProjects());
  ipcMain.handle("project:create", (_e, name: string, systemPrompt?: string) => createProject(name, systemPrompt));
  ipcMain.handle("project:update", (_e, id: string, patch: { name?: string; systemPrompt?: string }) =>
    updateProject(id, patch)
  );
  ipcMain.handle("project:delete", (_e, id: string) => deleteProject(id));

  // Cowork folder project (HANDBOOK COWORK §4 / §13) — separate from Spaces.
  ipcMain.handle("cowork:pick", (e) => pickCoworkProject(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle("cowork:set", (_e, root: string) => setCoworkRoot(root));
  ipcMain.handle("cowork:clear", () => {
    clearCoworkProject();
  });
  ipcMain.handle("cowork:state", () => getCoworkState());
  ipcMain.handle("cowork:checkpoint", () => createCheckpoint());
  ipcMain.handle("cowork:undo", () => undoCheckpoint());

  // Quick-chat (HANDBOOK M6). The mini window asks main to dismiss itself on
  // Escape / after "open in full chat".
  ipcMain.handle("quick:hide", () => hideQuickChat());

  ipcMain.handle("wan:focus", () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });
}
