// CommonJS preload (.cjs) -- runs in a sandboxed context and only uses
// contextBridge + ipcRenderer, both available under sandbox:true. Exposes a
// single frozen `window.wan` object; the renderer never sees raw ipcRenderer
// (handbook Tahap 2 / §12: validated named channels only).
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("wan", {
  // Generic transport replacing the old fetch()->HTTP+CORS path. `req` is
  // { method, path, body?, contentType? }; returns { ok, status, statusText, text }.
  request: (req) => invoke("wan:request", req),

  // Desktop-only actions.
  syncNow: () => invoke("wan:syncNow"),
  copyApiKey: () => invoke("wan:copyApiKey"),
  openExternal: (url) => invoke("wan:openExternal", url),
  vscodeState: () => invoke("wan:vscodeState"),
  backendInfo: () => invoke("wan:backendInfo"),
  copyText: (text) => invoke("wan:copyText", text),

  // JetBrains / ProxyAI direct-inject ("Jalur B").
  jetbrainsSync: () => invoke("wan:jetbrainsSync"),
  jetbrainsState: () => invoke("wan:jetbrainsState"),
  health: () => invoke("wan:health"),
  getSettings: () => invoke("wan:getSettings"),
  setSetting: (key, value) => invoke("wan:setSetting", key, value),
  focus: () => invoke("wan:focus"),

  // In-app Chat (HANDBOOK M1). start is fire-and-forget; tokens arrive via
  // onStream. onStream unwraps the { type:"chat", payload } envelope and hands
  // the payload (a ChatStreamEvent) to the callback; the renderer filters by
  // reqId. Returns an unsubscribe function.
  chat: {
    start: (payload) => invoke("chat:start", payload),
    abort: (reqId) => invoke("chat:abort", reqId),
    approve: (id) => invoke("chat:approve", id),
    reject: (id) => invoke("chat:reject", id),
    onStream: (cb) => {
      const listener = (_e, data) => {
        if (data && data.type === "chat" && data.payload) cb(data.payload);
      };
      ipcRenderer.on("wan:event", listener);
      return () => ipcRenderer.removeListener("wan:event", listener);
    },
  },

  // Conversation history (HANDBOOK M2). CRUD over userData/conversations/.
  convo: {
    list: () => invoke("convo:list"),
    get: (id) => invoke("convo:get", id),
    save: (convo) => invoke("convo:save", convo),
    delete: (id) => invoke("convo:delete", id),
    rename: (id, title) => invoke("convo:rename", id, title),
    search: (query, limit) => invoke("convo:search", query, limit),
  },

  // Chat context sources (HANDBOOK M5). File picking + web fetch happen in main
  // (renderer never opens a file handle or a socket); both return plain text.
  context: {
    pickFiles: () => invoke("context:pickFiles"),
    fetchUrl: (url) => invoke("context:fetchUrl", url),
  },

  // Projects / Spaces (HANDBOOK M6). Group conversations by project.
  project: {
    list: () => invoke("project:list"),
    create: (name, systemPrompt) => invoke("project:create", name, systemPrompt),
    update: (id, patch) => invoke("project:update", id, patch),
    delete: (id) => invoke("project:delete", id),
  },

  // Cowork folder (HANDBOOK COWORK). Filesystem agent root — not Spaces.
  cowork: {
    pick: () => invoke("cowork:pick"),
    set: (root) => invoke("cowork:set", root),
    clear: () => invoke("cowork:clear"),
    state: () => invoke("cowork:state"),
    checkpoint: () => invoke("cowork:checkpoint"),
    undo: () => invoke("cowork:undo"),
  },

  // Quick-chat mini window (HANDBOOK M6). The window asks main to dismiss it.
  quick: {
    hide: () => invoke("quick:hide"),
  },

  // main -> renderer push (sync results, health, live logs). Returns an
  // unsubscribe function.
  onEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("wan:event", listener);
    return () => ipcRenderer.removeListener("wan:event", listener);
  },
});

// Thin Super App bridge (optional — only present when running inside Super App shell).
try {
  contextBridge.exposeInMainWorld("superApp", {
    showHub: () => invoke("super:showHub"),
    openModule: (id) => invoke("super:openModule", id),
  });
} catch {
  /* already exposed or not needed */
}
