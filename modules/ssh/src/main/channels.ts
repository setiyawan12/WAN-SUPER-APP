export const CH = {
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
    restoreDeleted: "hosts:restoreDeleted",
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
    write: "session:write",
    resize: "session:resize",
    close: "session:close",
    answerAuthPrompt: "session:answerAuthPrompt",
    answerHostKey: "session:answerHostKey"
  },
  evt: {
    vaultLocked: "vault:locked",
    syncState: "sync:state",
    storeChanged: "store:changed"
  }
};
