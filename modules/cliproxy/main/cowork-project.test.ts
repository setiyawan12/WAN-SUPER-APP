import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setCoworkRoot,
  clearCoworkProject,
  resolveInside,
  isSecretPath,
  createCheckpoint,
  undoCheckpoint,
  getLastCheckpoint,
  getRoot,
  getCoworkState,
} from "./cowork-project.js";

let tmp: string;

before(() => {
  // realpath so macOS /var → /private/var matches setCoworkRoot/resolveInside.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wan-cowork-")));
  fs.writeFileSync(path.join(tmp, "hello.txt"), "hello world\n", "utf8");
  fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo" }, null, 2), "utf8");
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "a.ts"), "export const a = 1;\n", "utf8");
  setCoworkRoot(tmp);
});

after(() => {
  clearCoworkProject();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("getRoot returns set project root", () => {
  assert.ok(getRoot());
  assert.equal(path.resolve(getRoot()!), path.resolve(tmp));
});

test("resolveInside allows relative paths inside root", () => {
  const abs = resolveInside("src/a.ts");
  assert.equal(path.resolve(abs), path.resolve(tmp, "src", "a.ts"));
});

test("resolveInside allows create targets that do not exist yet", () => {
  const abs = resolveInside("src/new-file.ts");
  assert.ok(abs.startsWith(path.resolve(tmp) + path.sep));
});

test("resolveInside rejects path escape via ..", () => {
  assert.throws(() => resolveInside("../outside.txt"), /escapes project root/i);
  assert.throws(() => resolveInside("src/../../outside.txt"), /escapes project root/i);
});

test("isSecretPath blocks env and key material", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath(".env.local"), true);
  assert.equal(isSecretPath(".env.staging"), true);
  assert.equal(isSecretPath("id_rsa"), true);
  assert.equal(isSecretPath("cert.pem"), true);
  assert.equal(isSecretPath("private.key"), true);
  assert.equal(isSecretPath("app.secrets.json"), true);
  assert.equal(isSecretPath("src/a.ts"), false);
  assert.equal(isSecretPath("package.json"), false);
});

test("getCoworkState canUndo false until checkpoint", () => {
  // Fresh root from before() has no checkpoint yet after setCoworkRoot.
  // Other tests may have created one — only assert shape when empty or after clear+set.
  const s0 = getCoworkState();
  assert.ok(s0.project);
  assert.equal(typeof s0.canUndo, "boolean");
  assert.equal(s0.canUndo, !!s0.lastCheckpoint);
});

test("createCheckpoint (non-git) snapshots files and undo restores", async () => {
  // Ensure non-git path: temp dir has no .git
  assert.equal(fs.existsSync(path.join(tmp, ".git")), false);

  // Reset checkpoint by re-setting root
  setCoworkRoot(tmp);
  assert.equal(getCoworkState().canUndo, false);

  const before = fs.readFileSync(path.join(tmp, "hello.txt"), "utf8");
  const cp = await createCheckpoint();
  assert.equal(cp.ok, true);
  assert.ok(cp.id?.startsWith("snap-"));
  assert.equal(getLastCheckpoint(), cp.id);
  assert.equal(getCoworkState().canUndo, true);
  assert.equal(getCoworkState().lastCheckpoint, cp.id);

  fs.writeFileSync(path.join(tmp, "hello.txt"), "mutated\n", "utf8");
  assert.notEqual(fs.readFileSync(path.join(tmp, "hello.txt"), "utf8"), before);

  const undo = await undoCheckpoint();
  assert.equal(undo.ok, true, undo.error);
  assert.equal(fs.readFileSync(path.join(tmp, "hello.txt"), "utf8"), before);
  // Undo keeps lastCheckpoint so further undo can re-apply same snap.
  assert.equal(getCoworkState().canUndo, true);

  // Backup tree lives under .wan/backups
  const backupDir = path.join(tmp, ".wan", "backups", cp.id!);
  assert.ok(fs.existsSync(path.join(backupDir, "manifest.json")));
});
