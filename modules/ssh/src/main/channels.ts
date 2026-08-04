export const CH = {
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
  knownHosts: {
    list: "knownHosts:list",
    remove: "knownHosts:remove"
  },
  storage: {
    status: "storage:status",
    acknowledgeRecovery: "storage:acknowledgeRecovery"
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
  snippets: {
    list: "snippets:list",
    save: "snippets:save",
    remove: "snippets:remove",
    run: "snippets:run"
  },
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
  tunnels: {
    list: "tunnels:list",
    start: "tunnels:start",
    stop: "tunnels:stop"
  },
  diagnostics: {
    run: "diagnostics:run"
  },
  recording: {
    status: "recording:status",
    start: "recording:start",
    stop: "recording:stop",
    discard: "recording:discard"
  },
  evt: {
    termOutput: "term:output",
    termExit: "term:exit",
    sessionState: "session:state",
    hostKeyPrompt: "host:keyPrompt",
    authPrompt: "auth:prompt",
    transferProgress: "transfer:progress",
    tunnelChanged: "tunnel:changed",
    vaultLocked: "vault:locked",
    syncState: "sync:state",
    storeChanged: "store:changed"
  }
};
