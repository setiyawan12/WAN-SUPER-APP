import * as node_fs from "node:fs";
import { ipcMain, BrowserWindow, dialog } from "electron";
import { logger } from "./constants.js";
import { jsonStore } from "./store.js";
import { CH } from "./channels.js";
import { firebaseConfigPath } from "./firebase.js";
import { requireCtx } from "./runtime.js";
import {
  PasswordSchema,
  HostInputSchema,
  GroupInputSchema,
  IdentityInputSchema,
  SessionOpenSchema,
  KeyGenSchema,
  KeyImportSchema,
  IdSchema,
  SignInSchema,
  FirebaseConfigSchema
} from "./schemas.js";

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
  ipcMain.handle(CH.vault.biometricAvailable, () => requireCtx().biometricAvailable());
  ipcMain.handle(CH.vault.enableBiometric, async () => requireCtx().enableBiometric());
  ipcMain.handle(CH.hosts.list, () => requireCtx().hosts.listHosts());
  ipcMain.handle(CH.hosts.get, (_e, raw) => requireCtx().hosts.getHost(IdSchema.parse(raw)));
  ipcMain.handle(CH.hosts.save, (_e, raw) => requireCtx().hosts.saveHost(HostInputSchema.parse(raw)));
  ipcMain.handle(CH.hosts.remove, (_e, raw) => requireCtx().hosts.removeHost(IdSchema.parse(raw)));
  ipcMain.handle(CH.hosts.testConnection, (_e, raw) => requireCtx().ssh.testConnection(IdSchema.parse(raw)));
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
    const { sync } = requireCtx();
    const requeued = jsonStore.requeueAll();
    const outcome = await sync.syncNow();
    return { requeued, ...outcome };
  });
  ipcMain.handle(CH.sync.signIn, async (_e, rawEmail, rawPw) => {
    const { sync, syncTransport } = requireCtx();
    const { email, password } = SignInSchema.parse({ email: rawEmail, password: rawPw });
    const uid = await syncTransport.signIn(email, password);
    // Pull awal DITUNGGU (bukan fire-and-forget) supaya list host terisi begitu
    // sign-in selesai. Cursor sudah 0 (fresh) sehingga full pull dari RTDB.
    const outcome = await sync.syncNow();
    logger.info("signIn → syncNow:", JSON.stringify(outcome));
    // Jaminan: paksa renderer reload list SETELAH pull selesai, walau emit di
    // dalam pullPhase kebetulan terlewat karena listener renderer belum siap.
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
  ipcMain.handle(CH.session.open, async (_e, raw) => {
    const input = SessionOpenSchema.parse(raw);
    return requireCtx().ssh.open(input.hostId, input.cols, input.rows);
  });
  ipcMain.on(CH.session.write, (_e, sessionId, data2) => {
    if (typeof sessionId === "string" && typeof data2 === "string") requireCtx().ssh.write(sessionId, data2);
  });
  ipcMain.on(CH.session.resize, (_e, sessionId, cols, rows) => {
    requireCtx().ssh.resize(sessionId, cols, rows);
  });
  ipcMain.handle(CH.session.close, (_e, raw) => {
    requireCtx().ssh.close(IdSchema.parse(raw));
  });
  ipcMain.handle(CH.session.answerAuthPrompt, (_e, sessionId, answers) => {
    requireCtx().ssh.answerAuthPrompt(IdSchema.parse(sessionId), answers.map(String));
  });
  ipcMain.handle(CH.session.answerHostKey, (_e, sessionId, accept) => {
    requireCtx().ssh.answerHostKey(IdSchema.parse(sessionId), Boolean(accept));
  });
  logger.info("IPC handlers registered (live ctx)");
}
