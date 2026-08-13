import * as node_fs from "node:fs";
import { ipcMain as electronIpcMain, BrowserWindow, dialog } from "electron";
import { logger } from "./constants.js";
import { jsonStore } from "./store.js";
import { CH } from "./channels.js";
import { firebaseConfigPath } from "./firebase.js";
import { knownHosts } from "./knownhosts.js";
import { requireCtx } from "./runtime.js";
import { isTrustedIpcSender } from "./security.js";
import {
  PasswordSchema,
  AutoLockSchema,
  RevealPasswordSchema,
  HostInputSchema,
  GroupInputSchema,
  IdentityInputSchema,
  SessionOpenSchema,
  SessionReconnectSchema,
  SessionAuthAnswerSchema,
  SessionHostKeyAnswerSchema,
  LocalSessionOpenSchema,
  KeyGenSchema,
  KeyImportSchema,
  IdSchema,
  SignInSchema,
  FirebaseConfigSchema
  , TransferListSchema
  , TransferActionSchema
  , TransferRenameSchema
  , TransferRemoveSchema
  , TransferUploadSchema
  , TransferDownloadSchema
  , TunnelStartSchema
  , SnippetInputSchema
  , SnippetRunSchema
  , RecordingStartSchema
  , AuditListLimitSchema
} from "./schemas.js";

const AUDITED_CHANNELS = new Set<string>([
  CH.vault.create, CH.vault.unlock, CH.vault.lock, CH.vault.changePassword, CH.vault.enableBiometric,
  CH.hosts.revealPassword, CH.hosts.save, CH.hosts.remove, CH.hosts.restoreDeleted,
  CH.knownHosts.remove, CH.groups.save, CH.groups.remove, CH.identities.save, CH.identities.remove,
  CH.sync.pushAll, CH.sync.signIn, CH.sync.signInGoogle, CH.sync.signOut, CH.sync.importConfig,
  CH.keys.generate, CH.keys.importPem, CH.keys.pushToHost, CH.keys.remove,
  CH.snippets.save, CH.snippets.remove, CH.snippets.run,
  CH.session.open, CH.session.reconnect, CH.session.close, CH.session.answerHostKey,
  CH.transfer.upload, CH.transfer.download, CH.transfer.mkdir, CH.transfer.rename, CH.transfer.remove, CH.transfer.retry, CH.transfer.cancel,
  CH.tunnels.start, CH.tunnels.stop,
  CH.openSsh.importConfig,
  CH.recording.start, CH.recording.stop, CH.recording.discard
]);

function assertTrustedSender(event: any) {
  if (!isTrustedIpcSender(event.sender, requireCtx().sender)) throw new Error("IPC sender ditolak");
}

const ipcMain = {
  handle(channel: string, listener: (event: any, ...args: any[]) => any) {
    electronIpcMain.handle(channel, async (event, ...args) => {
      assertTrustedSender(event);
      try {
        const result = await listener(event, ...args);
        if (AUDITED_CHANNELS.has(channel)) requireCtx().audit.record(channel);
        return result;
      } catch (error) {
        if (AUDITED_CHANNELS.has(channel)) {
          requireCtx().audit.record(channel, { error: error instanceof Error ? error.message : String(error) }, "failure");
        }
        throw error;
      }
    });
  },
  on(channel: string, listener: (event: any, ...args: any[]) => void) {
    electronIpcMain.on(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event.sender, requireCtx().sender)) return;
      listener(event, ...args);
    });
  }
};

/**
 * IPC selalu membaca `ctx` global (bukan closure register pertama).
 * Kalau module di-shutdown/re-init, AppContext diganti — handler lama tidak boleh
 * tetap memegang syncTransport in-memory yang sudah basah.
 */
export function registerIpc() {
  ipcMain.handle(CH.vault.status, () => ({ state: requireCtx().vault.status() }));
  ipcMain.handle(CH.vault.create, async (_e, raw) => {
    await requireCtx().vault.create(PasswordSchema.parse(raw));
  });
  ipcMain.handle(CH.vault.unlock, async (_e, raw) => {
    await requireCtx().vault.unlock(PasswordSchema.parse(raw));
  });
  ipcMain.handle(CH.vault.lock, () => requireCtx().vault.lock());
  ipcMain.handle(CH.vault.changePassword, async (_e, oldPw, newPw) => {
    await requireCtx().vault.changePassword(PasswordSchema.parse(oldPw), PasswordSchema.parse(newPw));
  });
  ipcMain.handle(CH.vault.settings, () => requireCtx().vaultSettings());
  ipcMain.handle(CH.vault.setAutoLock, (_e, raw) => requireCtx().setAutoLockMs(AutoLockSchema.parse(raw)));
  ipcMain.handle(CH.vault.tryBiometricUnlock, () => requireCtx().tryBiometricUnlock());
  ipcMain.handle(CH.vault.biometricAvailable, () => requireCtx().biometricAvailable());
  ipcMain.handle(CH.vault.enableBiometric, async () => requireCtx().enableBiometric());
  ipcMain.handle(CH.hosts.list, () => requireCtx().hosts.listHosts());
  ipcMain.handle(CH.hosts.get, (_e, raw) => requireCtx().hosts.getHost(IdSchema.parse(raw)));
  ipcMain.handle(CH.hosts.revealPassword, async (_e, raw) => {
    const input = RevealPasswordSchema.parse(raw);
    if (!(await requireCtx().authorizeSensitiveAction(input))) throw new Error("Re-authentication gagal");
    return { password: requireCtx().hosts.revealPassword(input.id) };
  });
  ipcMain.handle(CH.hosts.save, (_e, raw) => requireCtx().hosts.saveHost(HostInputSchema.parse(raw)));
  ipcMain.handle(CH.hosts.remove, (_e, raw) => requireCtx().hosts.removeHost(IdSchema.parse(raw)));
  ipcMain.handle(CH.hosts.restoreDeleted, async () => {
    const ctx = requireCtx();
    const restored = ctx.hosts.restoreLatestDeletedHost();
    if (!restored) return { restored: false };
    const outcome = await ctx.sync.syncNow();
    ctx.emit(CH.evt.storeChanged, void 0);
    return { restored: true, id: restored.id, sync: outcome };
  });
  ipcMain.handle(CH.hosts.testConnection, (_e, raw) => requireCtx().ssh.testConnection(IdSchema.parse(raw)));
  ipcMain.handle(CH.diagnostics.run, (_e, raw) => requireCtx().diagnostics.run(IdSchema.parse(raw)));
  ipcMain.handle(CH.openSsh.importConfig, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options: any = {
      title: "Import OpenSSH config",
      defaultPath: require("node:path").join(require("node:os").homedir(), ".ssh", "config"),
      properties: ["openFile"]
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, imported: 0, updated: 0, warnings: [] };
    const stat = node_fs.statSync(result.filePaths[0]);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("OpenSSH config harus berupa file berukuran maksimal 2 MiB");
    const outcome = requireCtx().openSsh.import(node_fs.readFileSync(result.filePaths[0]));
    requireCtx().emit(CH.evt.storeChanged, void 0);
    return { canceled: false, ...outcome };
  });
  ipcMain.handle(CH.audit.list, (_e, raw) => requireCtx().audit.list(raw === undefined ? 100 : AuditListLimitSchema.parse(raw)));
  ipcMain.handle(CH.knownHosts.list, () => knownHosts.list());
  ipcMain.handle(CH.knownHosts.remove, (_e, raw) => knownHosts.remove(IdSchema.parse(raw)));
  ipcMain.handle(CH.storage.status, () => jsonStore.storageStatus());
  ipcMain.handle(CH.storage.acknowledgeRecovery, () => jsonStore.acknowledgeRecovery());
  ipcMain.handle(CH.groups.list, () => requireCtx().hosts.listGroups());
  ipcMain.handle(CH.groups.save, (_e, raw) => requireCtx().hosts.saveGroup(GroupInputSchema.parse(raw)));
  ipcMain.handle(CH.groups.remove, (_e, raw) => requireCtx().hosts.removeGroup(IdSchema.parse(raw)));
  ipcMain.handle(CH.identities.list, () => requireCtx().identities.list());
  ipcMain.handle(CH.identities.save, (_e, raw) => requireCtx().identities.save(IdentityInputSchema.parse(raw)));
  ipcMain.handle(CH.identities.remove, (_e, raw) => requireCtx().identities.remove(IdSchema.parse(raw)));
  ipcMain.handle(CH.sync.status, async () => {
    const { sync, syncTransport } = requireCtx();
    // Tunggu restore sesi agar UI tidak selalu minta Sign in saat boot.
    if (syncTransport.isConfigured() && !syncTransport.currentUser()) {
      try {
        await syncTransport.restoreSession();
      } catch (e) {
        logger.warn("restore sesi saat status gagal", e);
      }
    }
    return sync.status();
  });
  ipcMain.handle(CH.sync.now, () => requireCtx().sync.syncNow());
  ipcMain.handle(CH.sync.pushAll, async () => {
    const { sync, vault } = requireCtx();
    try {
      vault.assertCanDecryptItems(jsonStore.listSyncedPayloads());
    } catch (error) {
      if (error instanceof Error && error.message === "UNDECRYPTABLE") {
        throw new Error("Re-upload dibatalkan: ada kredensial Cloud yang memakai Vault Key berbeda. Simpan ulang kredensial tersebut lebih dulu.");
      }
      throw error;
    }
    const requeued = jsonStore.requeueAll();
    const outcome = await sync.syncNow({ forceLocal: true });
    return { requeued, ...outcome };
  });
  ipcMain.handle(CH.sync.signIn, async (_e, rawEmail, rawPw) => {
    const { sync, syncTransport } = requireCtx();
    const { email, password } = SignInSchema.parse({ email: rawEmail, password: rawPw });
    const uid = await syncTransport.signIn(email, password);
    // Pull awal DITUNGGU (bukan fire-and-forget) supaya list host terisi begitu
    // sign-in selesai. Cursor sudah 0 (fresh) sehingga full pull dari RTDB.
    const outcome = await sync.syncNow({ preferRemoteMeta: true });
    logger.info("signIn → syncNow:", JSON.stringify(outcome));
    if (!outcome.ok) throw new Error(`Sign in berhasil, tetapi pull RTDB gagal: ${outcome.reason}`);
    // Jaminan: paksa renderer reload list SETELAH pull selesai, walau emit di
    // dalam pullPhase kebetulan terlewat karena listener renderer belum siap.
    requireCtx().emit(CH.evt.storeChanged, void 0);
    return { uid };
  });
  ipcMain.handle(CH.sync.signInGoogle, async () => {
    const { sync, syncTransport } = requireCtx();
    const uid = await syncTransport.signInGoogle();
    const outcome = await sync.syncNow({ preferRemoteMeta: true });
    logger.info("signInGoogle → syncNow:", JSON.stringify(outcome));
    if (!outcome.ok) throw new Error(`Sign in Google berhasil, tetapi pull RTDB gagal: ${outcome.reason}`);
    requireCtx().emit(CH.evt.storeChanged, void 0);
    return { uid };
  });
  ipcMain.handle(CH.sync.signOut, async () => {
    await requireCtx().syncTransport.signOut();
    return { ok: true };
  });
  ipcMain.handle(CH.sync.importConfig, async () => {
    const { syncTransport } = requireCtx();
    const win = BrowserWindow.getFocusedWindow();
    const opts: any = {
      title: "Pilih firebase-config.json",
      filters: [{ name: "Firebase config", extensions: ["json"] }],
      properties: ["openFile"]
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) {
      return { configured: syncTransport.isConfigured(), canceled: true };
    }
    try {
      const cfg = FirebaseConfigSchema.parse(JSON.parse(node_fs.readFileSync(res.filePaths[0], "utf8")));
      node_fs.writeFileSync(firebaseConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
      const configured = syncTransport.reloadConfig();
      if (configured) {
        try {
          await syncTransport.restoreSession();
        } catch (e) {
          logger.warn("restore sesi setelah import config gagal", e);
        }
      }
      logger.info("Firebase config diimpor; sync configured =", configured, "user =", syncTransport.currentUser());
      return { configured, user: syncTransport.currentUser() };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { configured: requireCtx().syncTransport.isConfigured(), error: `File config tidak valid: ${error}` };
    }
  });
  ipcMain.handle(CH.keys.list, () => requireCtx().keys.list());
  ipcMain.handle(CH.keys.generate, (_e, raw) => requireCtx().keys.generate(KeyGenSchema.parse(raw)));
  ipcMain.handle(CH.keys.exportPublic, (_e, raw) => requireCtx().keys.exportPublic(IdSchema.parse(raw)));
  ipcMain.handle(CH.keys.importPem, (_e, raw) => requireCtx().keys.importPem(KeyImportSchema.parse(raw)));
  ipcMain.handle(CH.keys.remove, (_e, raw) => requireCtx().keys.remove(IdSchema.parse(raw)));
  ipcMain.handle(CH.keys.pushToHost, async (_e, keyId, hostId) => {
    const { keys, ssh } = requireCtx();
    const pub = keys.exportPublic(IdSchema.parse(keyId));
    await ssh.pushKey(pub, IdSchema.parse(hostId));
  });
  ipcMain.handle(CH.snippets.list, () => requireCtx().snippets.list());
  ipcMain.handle(CH.snippets.save, (_e, raw) => requireCtx().snippets.save(SnippetInputSchema.parse(raw)));
  ipcMain.handle(CH.snippets.remove, (_e, raw) => requireCtx().snippets.remove(IdSchema.parse(raw)));
  ipcMain.handle(CH.snippets.run, (_e, raw) => {
    const input = SnippetRunSchema.parse(raw);
    const snippet = requireCtx().snippets.get(input.snippetId);
    if (!snippet) throw new Error("Snippet tidak ditemukan");
    const data = `${snippet.command}${input.appendNewline === false ? "" : "\r"}`;
    const ctx = requireCtx();
    if (ctx.local.has(input.sessionId)) ctx.local.write(input.sessionId, data);
    else ctx.ssh.write(input.sessionId, data);
  });
  ipcMain.handle(CH.session.open, async (_e, raw) => {
    const input = SessionOpenSchema.parse(raw);
    return requireCtx().ssh.open(input.hostId, input.cols, input.rows);
  });
  ipcMain.handle(CH.session.reconnect, async (_e, raw) => {
    const input = SessionReconnectSchema.parse(raw);
    return requireCtx().ssh.reconnect(input.sessionId, input.cols, input.rows);
  });
  ipcMain.handle(CH.session.openLocal, (_e, raw) => requireCtx().local.open(LocalSessionOpenSchema.parse(raw)));
  ipcMain.on(CH.session.write, (_e, sessionId, data2) => {
    const parsedId = IdSchema.safeParse(sessionId);
    if (!parsedId.success || typeof data2 !== "string" || data2.length > 1_000_000) return;
    const ctx = requireCtx();
    ctx.vault.touch();
    ctx.recording.captureInput(parsedId.data, data2);
    if (ctx.local.has(parsedId.data)) ctx.local.write(parsedId.data, data2);
    else ctx.ssh.write(parsedId.data, data2);
  });
  ipcMain.on(CH.session.resize, (_e, sessionId, cols, rows) => {
    const parsedId = IdSchema.safeParse(sessionId);
    const width = Number(cols);
    const height = Number(rows);
    if (!parsedId.success || !Number.isInteger(width) || width < 1 || width > 1000 || !Number.isInteger(height) || height < 1 || height > 1000) return;
    const ctx = requireCtx();
    if (ctx.local.has(parsedId.data)) ctx.local.resize(parsedId.data, width, height);
    else ctx.ssh.resize(parsedId.data, width, height);
  });
  ipcMain.handle(CH.session.close, (_e, raw) => {
    const sessionId = IdSchema.parse(raw);
    const ctx = requireCtx();
    if (ctx.local.has(sessionId)) ctx.local.close(sessionId);
    else ctx.ssh.close(sessionId);
  });
  ipcMain.handle(CH.session.answerAuthPrompt, (_e, sessionId, answers) => {
    const input = SessionAuthAnswerSchema.parse({ sessionId, answers });
    requireCtx().ssh.answerAuthPrompt(input.sessionId, input.answers);
  });
  ipcMain.handle(CH.session.answerHostKey, (_e, sessionId, accept) => {
    const input = SessionHostKeyAnswerSchema.parse({ sessionId, accept });
    requireCtx().ssh.answerHostKey(input.sessionId, input.accept);
  });
  ipcMain.handle(CH.transfer.home, (_e, raw) => requireCtx().transfers.home(IdSchema.parse(raw)));
  ipcMain.handle(CH.transfer.list, (_e, raw) => {
    const input = TransferListSchema.parse(raw);
    return requireCtx().transfers.list(input.sessionId, input.path);
  });
  ipcMain.handle(CH.transfer.mkdir, (_e, raw) => {
    const input = TransferActionSchema.parse(raw);
    return requireCtx().transfers.mkdir(input.sessionId, input.path);
  });
  ipcMain.handle(CH.transfer.rename, (_e, raw) => {
    const input = TransferRenameSchema.parse(raw);
    return requireCtx().transfers.rename(input.sessionId, input.from, input.to);
  });
  ipcMain.handle(CH.transfer.remove, (_e, raw) => {
    const input = TransferRemoveSchema.parse(raw);
    return requireCtx().transfers.remove(input.sessionId, input.path, input.directory);
  });
  ipcMain.handle(CH.transfer.upload, async (_e, raw) => {
    const input = TransferUploadSchema.parse(raw);
    let paths = input.localPaths ?? [];
    if (!paths.length) {
      const win = BrowserWindow.getFocusedWindow();
      const options: any = { title: "Pilih file untuk diunggah", properties: ["openFile", "multiSelections"] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      paths = result.filePaths;
    }
    return paths.map((localPath) => requireCtx().transfers.upload(
      input.sessionId,
      localPath,
      require("node:path").posix.join(input.remoteDirectory, require("node:path").basename(localPath)),
      input.resume ?? true
    ));
  });
  ipcMain.handle(CH.transfer.download, async (_e, raw) => {
    const input = TransferDownloadSchema.parse(raw);
    const win = BrowserWindow.getFocusedWindow();
    const options: any = { title: "Simpan file", defaultPath: require("node:path").basename(input.remotePath) };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return requireCtx().transfers.download(input.sessionId, input.remotePath, result.filePath, input.resume ?? true);
  });
  ipcMain.handle(CH.transfer.jobs, () => requireCtx().transfers.listJobs());
  ipcMain.handle(CH.transfer.retry, (_e, raw) => requireCtx().transfers.retry(IdSchema.parse(raw)));
  ipcMain.handle(CH.transfer.cancel, (_e, raw) => requireCtx().transfers.cancel(IdSchema.parse(raw)));
  ipcMain.handle(CH.tunnels.list, (_e, raw) => requireCtx().tunnels.list(raw ? IdSchema.parse(raw) : undefined));
  ipcMain.handle(CH.tunnels.start, (_e, raw) => requireCtx().tunnels.start(TunnelStartSchema.parse(raw)));
  ipcMain.handle(CH.tunnels.stop, (_e, raw) => requireCtx().tunnels.stop(IdSchema.parse(raw)));
  ipcMain.handle(CH.recording.status, (_e, raw) => requireCtx().recording.status(raw ? IdSchema.parse(raw) : undefined));
  ipcMain.handle(CH.recording.start, (_e, raw) => {
    const input = RecordingStartSchema.parse(raw);
    const ctx = requireCtx();
    if (!ctx.local.has(input.sessionId) && !ctx.ssh.getSession(input.sessionId)) throw new Error("Sesi tidak ditemukan");
    return ctx.recording.start(input.sessionId, input.cols, input.rows, input.includeInput ?? false);
  });
  ipcMain.handle(CH.recording.stop, async (_e, raw) => {
    const sessionId = IdSchema.parse(raw);
    const recording = requireCtx().recording.stop(sessionId);
    const win = BrowserWindow.getFocusedWindow();
    const options: any = {
      title: "Simpan rekaman terminal",
      defaultPath: `wann-ssh-${new Date(recording.startedAt).toISOString().replace(/[:.]/g, "-")}.cast`,
      filters: [{ name: "Asciicast", extensions: ["cast"] }]
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      requireCtx().recording.restore(recording);
      return { saved: false };
    }
    return { saved: true, ...requireCtx().recording.save(recording, result.filePath) };
  });
  ipcMain.handle(CH.recording.discard, (_e, raw) => requireCtx().recording.discard(IdSchema.parse(raw)));
  logger.info("IPC handlers registered (live ctx)");
}
