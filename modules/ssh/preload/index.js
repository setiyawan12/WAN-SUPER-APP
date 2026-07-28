"use strict";
const electron = require("electron");
const CH = {
  vault: {
    status: "vault:status",
    create: "vault:create",
    unlock: "vault:unlock",
    lock: "vault:lock",
    changePassword: "vault:changePassword",
    enableBiometric: "vault:enableBiometric",
    biometricAvailable: "vault:biometricAvailable"
  },
  hosts: {
    list: "hosts:list",
    get: "hosts:get",
    revealPassword: "hosts:revealPassword",
    save: "hosts:save",
    remove: "hosts:remove",
    testConnection: "hosts:testConnection"
  },
  groups: {
    list: "groups:list",
    save: "groups:save",
    remove: "groups:remove"
  },
  identities: {
    list: "identities:list",
    save: "identities:save",
    remove: "identities:remove"
  },
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
  session: {
    open: "session:open",
    openLocal: "session:openLocal",
    write: "session:write",
    resize: "session:resize",
    close: "session:close",
    answerAuthPrompt: "session:answerAuthPrompt",
    answerHostKey: "session:answerHostKey"
  },
  evt: {
    termOutput: "term:output",
    termExit: "term:exit",
    hostKeyPrompt: "host:keyPrompt",
    authPrompt: "auth:prompt",
    transferProgress: "transfer:progress",
    storeChanged: "store:changed",
    vaultLocked: "vault:locked",
    syncState: "sync:state"
  }
};
const invoke = (ch, ...a) => electron.ipcRenderer.invoke(ch, ...a);
const on = (ch, cb) => {
  const handler = (_e, ...a) => cb(...a);
  electron.ipcRenderer.on(ch, handler);
  return () => electron.ipcRenderer.off(ch, handler);
};
const api = {
  vault: {
    status: () => invoke(CH.vault.status),
    create: (p) => invoke(CH.vault.create, p),
    unlock: (p) => invoke(CH.vault.unlock, p),
    lock: () => invoke(CH.vault.lock),
    changePassword: (o, n) => invoke(CH.vault.changePassword, o, n),
    enableBiometric: () => invoke(CH.vault.enableBiometric),
    biometricAvailable: () => invoke(CH.vault.biometricAvailable)
  },
  hosts: {
    list: () => invoke(CH.hosts.list),
    get: (id) => invoke(CH.hosts.get, id),
    revealPassword: (id) => invoke(CH.hosts.revealPassword, id),
    save: (input) => invoke(CH.hosts.save, input),
    remove: (id) => invoke(CH.hosts.remove, id),
    testConnection: (id) => invoke(CH.hosts.testConnection, id)
  },
  groups: {
    list: () => invoke(CH.groups.list),
    save: (input) => invoke(CH.groups.save, input),
    remove: (id) => invoke(CH.groups.remove, id)
  },
  identities: {
    list: () => invoke(CH.identities.list),
    save: (input) => invoke(CH.identities.save, input),
    remove: (id) => invoke(CH.identities.remove, id)
  },
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
    generate: (o) => invoke(CH.keys.generate, o),
    importPem: (o) => invoke(CH.keys.importPem, o),
    exportPublic: (id) => invoke(CH.keys.exportPublic, id),
    pushToHost: (keyId, hostId) => invoke(CH.keys.pushToHost, keyId, hostId),
    remove: (id) => invoke(CH.keys.remove, id)
  },
  session: {
    open: (o) => invoke(CH.session.open, o),
    openLocal: (o) => invoke(CH.session.openLocal, o),
    write: (id, data) => electron.ipcRenderer.send(CH.session.write, id, data),
    resize: (id, cols, rows) => electron.ipcRenderer.send(CH.session.resize, id, cols, rows),
    close: (id) => invoke(CH.session.close, id),
    answerAuthPrompt: (id, answers) => invoke(CH.session.answerAuthPrompt, id, answers),
    answerHostKey: (id, accept) => invoke(CH.session.answerHostKey, id, accept)
  },
  on: {
    termOutput: (cb) => on(CH.evt.termOutput, (p) => cb(p)),
    termExit: (cb) => on(CH.evt.termExit, (p) => cb(p)),
    hostKeyPrompt: (cb) => on(CH.evt.hostKeyPrompt, (p) => cb(p)),
    authPrompt: (cb) => on(CH.evt.authPrompt, (p) => cb(p)),
    transferProgress: (cb) => on(CH.evt.transferProgress, (p) => cb(p)),
    storeChanged: (cb) => on(CH.evt.storeChanged, (p) => cb(p)),
    vaultLocked: (cb) => on(CH.evt.vaultLocked, () => cb()),
    syncState: (cb) => on(CH.evt.syncState, (p) => cb(p))
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
if (process.argv.includes("--wan-super-app-embed")) {
  electron.contextBridge.exposeInMainWorld("superApp", {
    showHub: () => electron.ipcRenderer.invoke("super:showHub"),
    openModule: (id) => electron.ipcRenderer.invoke("super:openModule", id)
  });
}
