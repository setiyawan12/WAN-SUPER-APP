"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const vault_1 = require("../../src/main/vault");
const web_vault_1 = require("./web-vault");
(0, node_test_1.default)("web and desktop vault envelopes decrypt in both directions", async () => {
    const metadata = new Map();
    const desktop = new vault_1.VaultCore({
        load: (id) => metadata.get(id) ?? null,
        save: (value) => metadata.set(value.vaultId, value)
    });
    const password = "WanSshParity123!";
    await desktop.create(password);
    const web = new web_vault_1.WebVault();
    await web.unlock(password, metadata.get("personal"));
    const webItemId = "00000000-0000-4000-8000-000000000001";
    const webEnvelope = await web.encryptString("WEB_TO_DESKTOP_OK", webItemId, "secret");
    strict_1.default.equal(desktop.decryptString(webEnvelope, webItemId), "WEB_TO_DESKTOP_OK");
    const desktopItemId = "00000000-0000-4000-8000-000000000002";
    const desktopEnvelope = desktop.encryptField("DESKTOP_TO_WEB_OK", desktopItemId, "secret");
    strict_1.default.equal(await web.decryptString(desktopEnvelope, desktopItemId), "DESKTOP_TO_WEB_OK");
    desktop.lock();
    web.lock();
});
