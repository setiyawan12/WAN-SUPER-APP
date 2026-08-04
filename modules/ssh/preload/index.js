"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const CH = {
  vault: {
    status: "vault:status",
    create: "vault:create",
    unlock: "vault:unlock",
    lock: "vault:lock",
    changePassword: "vault:changePassword",
    settings: "vault:settings",
    setAutoLock: "vault:setAutoLock",
    tryBiometricUnlock: "vault:tryBiometricUnlock",
    enableBiometric: "vault:enableBiometric",
    biometricAvailable: "vault:biometricAvailable"
  },
  hosts: {
    list: "hosts:list",
    get: "hosts:get",
    revealPassword: "hosts:revealPassword",
    save: "hosts:save",
    remove: "hosts:remove",
    restoreDeleted: "hosts:restoreDeleted",
    testConnection: "hosts:testConnection"
  },
  knownHosts: { list: "knownHosts:list", remove: "knownHosts:remove" },
  storage: { status: "storage:status", acknowledgeRecovery: "storage:acknowledgeRecovery" },
  groups: { list: "groups:list", save: "groups:save", remove: "groups:remove" },
  identities: { list: "identities:list", save: "identities:save", remove: "identities:remove" },
  sync: {
    status: "sync:status",
    now: "sync:now",
    pushAll: "sync:pushAll",
    signIn: "sync:signIn",
    signInGoogle: "sync:signInGoogle",
    signOut: "sync:signOut",
    importConfig: "sync:importConfig"
  },
  keys: {
    list: "keys:list",
    generate: "keys:generate",
    importPem: "keys:importPem",
    exportPublic: "keys:exportPublic",
    pushToHost: "keys:pushToHost",
    remove: "keys:remove"
  },
  snippets: { list: "snippets:list", save: "snippets:save", remove: "snippets:remove", run: "snippets:run" },
  session: {
    open: "session:open",
    openLocal: "session:openLocal",
    reconnect: "session:reconnect",
    write: "session:write",
    resize: "session:resize",
    close: "session:close",
    answerAuthPrompt: "session:answerAuthPrompt",
    answerHostKey: "session:answerHostKey"
  },
  transfer: {
    home: "transfer:home",
    list: "transfer:list",
    upload: "transfer:upload",
    download: "transfer:download",
    mkdir: "transfer:mkdir",
    rename: "transfer:rename",
    remove: "transfer:remove",
    jobs: "transfer:jobs",
    retry: "transfer:retry",
    cancel: "transfer:cancel"
  },
  tunnels: { list: "tunnels:list", start: "tunnels:start", stop: "tunnels:stop" },
  diagnostics: { run: "diagnostics:run" },
  recording: { status: "recording:status", start: "recording:start", stop: "recording:stop", discard: "recording:discard" },
  evt: {
    termOutput: "term:output",
    termExit: "term:exit",
    sessionState: "session:state",
    hostKeyPrompt: "host:keyPrompt",
    authPrompt: "auth:prompt",
    transferProgress: "transfer:progress",
    tunnelChanged: "tunnel:changed",
    storeChanged: "store:changed",
    vaultLocked: "vault:locked",
    syncState: "sync:state"
  }
};

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld("api", {
  vault: {
    status: () => invoke(CH.vault.status),
    create: (password) => invoke(CH.vault.create, password),
    unlock: (password) => invoke(CH.vault.unlock, password),
    lock: () => invoke(CH.vault.lock),
    changePassword: (oldPassword, newPassword) => invoke(CH.vault.changePassword, oldPassword, newPassword),
    settings: () => invoke(CH.vault.settings),
    setAutoLock: (milliseconds) => invoke(CH.vault.setAutoLock, milliseconds),
    tryBiometricUnlock: () => invoke(CH.vault.tryBiometricUnlock),
    enableBiometric: () => invoke(CH.vault.enableBiometric),
    biometricAvailable: () => invoke(CH.vault.biometricAvailable)
  },
  hosts: {
    list: () => invoke(CH.hosts.list),
    get: (id) => invoke(CH.hosts.get, id),
    revealPassword: (input) => invoke(CH.hosts.revealPassword, input),
    save: (input) => invoke(CH.hosts.save, input),
    remove: (id) => invoke(CH.hosts.remove, id),
    restoreDeleted: () => invoke(CH.hosts.restoreDeleted),
    testConnection: (id) => invoke(CH.hosts.testConnection, id)
  },
  knownHosts: { list: () => invoke(CH.knownHosts.list), remove: (id) => invoke(CH.knownHosts.remove, id) },
  storage: { status: () => invoke(CH.storage.status), acknowledgeRecovery: () => invoke(CH.storage.acknowledgeRecovery) },
  groups: { list: () => invoke(CH.groups.list), save: (input) => invoke(CH.groups.save, input), remove: (id) => invoke(CH.groups.remove, id) },
  identities: { list: () => invoke(CH.identities.list), save: (input) => invoke(CH.identities.save, input), remove: (id) => invoke(CH.identities.remove, id) },
  sync: {
    status: () => invoke(CH.sync.status),
    now: () => invoke(CH.sync.now),
    pushAll: () => invoke(CH.sync.pushAll),
    signIn: (email, password) => invoke(CH.sync.signIn, email, password),
    signInGoogle: () => invoke(CH.sync.signInGoogle),
    signOut: () => invoke(CH.sync.signOut),
    importConfig: () => invoke(CH.sync.importConfig)
  },
  keys: {
    list: () => invoke(CH.keys.list),
    generate: (input) => invoke(CH.keys.generate, input),
    importPem: (input) => invoke(CH.keys.importPem, input),
    exportPublic: (id) => invoke(CH.keys.exportPublic, id),
    pushToHost: (keyId, hostId) => invoke(CH.keys.pushToHost, keyId, hostId),
    remove: (id) => invoke(CH.keys.remove, id)
  },
  snippets: {
    list: () => invoke(CH.snippets.list),
    save: (input) => invoke(CH.snippets.save, input),
    remove: (id) => invoke(CH.snippets.remove, id),
    run: (input) => invoke(CH.snippets.run, input)
  },
  session: {
    open: (input) => invoke(CH.session.open, input),
    openLocal: (input) => invoke(CH.session.openLocal, input),
    reconnect: (input) => invoke(CH.session.reconnect, input),
    write: (id, data) => ipcRenderer.send(CH.session.write, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(CH.session.resize, id, cols, rows),
    close: (id) => invoke(CH.session.close, id),
    answerAuthPrompt: (id, answers) => invoke(CH.session.answerAuthPrompt, id, answers),
    answerHostKey: (id, accept) => invoke(CH.session.answerHostKey, id, accept)
  },
  transfer: {
    home: (sessionId) => invoke(CH.transfer.home, sessionId),
    list: (input) => invoke(CH.transfer.list, input),
    upload: (input) => invoke(CH.transfer.upload, {
      sessionId: input.sessionId,
      remoteDirectory: input.remoteDirectory,
      resume: input.resume
    }),
    uploadDropped: (sessionId, remoteDirectory, files, resume = true) => invoke(CH.transfer.upload, {
      sessionId,
      remoteDirectory,
      resume,
      localPaths: Array.from(files || []).map((file) => webUtils.getPathForFile(file)).filter(Boolean)
    }),
    download: (input) => invoke(CH.transfer.download, input),
    mkdir: (input) => invoke(CH.transfer.mkdir, input),
    rename: (input) => invoke(CH.transfer.rename, input),
    remove: (input) => invoke(CH.transfer.remove, input),
    jobs: () => invoke(CH.transfer.jobs),
    retry: (id) => invoke(CH.transfer.retry, id),
    cancel: (id) => invoke(CH.transfer.cancel, id)
  },
  tunnels: { list: (sessionId) => invoke(CH.tunnels.list, sessionId), start: (input) => invoke(CH.tunnels.start, input), stop: (id) => invoke(CH.tunnels.stop, id) },
  diagnostics: { run: (hostId) => invoke(CH.diagnostics.run, hostId) },
  recording: {
    status: (sessionId) => invoke(CH.recording.status, sessionId),
    start: (input) => invoke(CH.recording.start, input),
    stop: (sessionId) => invoke(CH.recording.stop, sessionId),
    discard: (sessionId) => invoke(CH.recording.discard, sessionId)
  },
  on: {
    termOutput: (callback) => on(CH.evt.termOutput, callback),
    termExit: (callback) => on(CH.evt.termExit, callback),
    sessionState: (callback) => on(CH.evt.sessionState, callback),
    hostKeyPrompt: (callback) => on(CH.evt.hostKeyPrompt, callback),
    authPrompt: (callback) => on(CH.evt.authPrompt, callback),
    transferProgress: (callback) => on(CH.evt.transferProgress, callback),
    tunnelChanged: (callback) => on(CH.evt.tunnelChanged, callback),
    storeChanged: (callback) => on(CH.evt.storeChanged, callback),
    vaultLocked: (callback) => on(CH.evt.vaultLocked, callback),
    syncState: (callback) => on(CH.evt.syncState, callback)
  }
});

if (process.argv.includes("--wan-super-app-embed")) {
  contextBridge.exposeInMainWorld("superApp", {
    showHub: () => ipcRenderer.invoke("super:showHub"),
    openModule: (id) => ipcRenderer.invoke("super:openModule", id),
    sendToChat: (context) => ipcRenderer.invoke("super:sendToChat", context)
  });
}
