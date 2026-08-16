import assert from "node:assert/strict";
import test from "node:test";
import { VaultCore } from "../../src/main/vault";
import { WebVault, type VaultEnvelope } from "./web-vault";

test("web and desktop vault envelopes decrypt in both directions", async () => {
  const metadata = new Map<string, any>();
  const desktop = new VaultCore({
    load: (id: string) => metadata.get(id) ?? null,
    save: (value: any) => metadata.set(value.vaultId, value)
  });
  const password = "WanSshParity123!";
  await desktop.create(password);

  const web = new WebVault();
  await web.unlock(password, metadata.get("personal"));

  const webItemId = "00000000-0000-4000-8000-000000000001";
  const webEnvelope = await web.encryptString("WEB_TO_DESKTOP_OK", webItemId, "secret");
  assert.equal(desktop.decryptString(webEnvelope, webItemId), "WEB_TO_DESKTOP_OK");

  const desktopItemId = "00000000-0000-4000-8000-000000000002";
  const desktopEnvelope = desktop.encryptField("DESKTOP_TO_WEB_OK", desktopItemId, "secret");
  assert.equal(await web.decryptString(desktopEnvelope as VaultEnvelope, desktopItemId), "DESKTOP_TO_WEB_OK");

  desktop.lock();
  web.lock();
});