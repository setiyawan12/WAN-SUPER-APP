/**
 * electron-builder `afterSign` hook — notarize the signed .app via `xcrun
 * notarytool` directly, with retries.
 *
 * Why not electron-builder's built-in `notarize`? It delegates to
 * @electron/notarize which does `JSON.parse(notarytool output)` with NO retry.
 * Apple's notary service intermittently returns a plain-text "Error: HTTP …"
 * instead of JSON, which crashes JSON.parse and fails the whole build. Calling
 * notarytool ourselves lets us retry those transient HTTP errors and staple.
 *
 * Requires env: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
 * If any is missing, notarization is skipped (build still produces a signed app).
 */
const { execFileSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("[notarize] APPLE_* env not set — skipping notarization (signed only).");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const zipPath = path.join(mkdtempSync(path.join(os.tmpdir(), "notarize-")), "app.zip");

  console.log(`[notarize] zipping ${appPath}`);
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath], {
    stdio: "inherit",
  });

  const auth = [
    "--apple-id", APPLE_ID,
    "--team-id", APPLE_TEAM_ID,
    "--password", APPLE_APP_SPECIFIC_PASSWORD,
  ];

  let accepted = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !accepted; attempt++) {
    console.log(`[notarize] submit attempt ${attempt}/${MAX_ATTEMPTS}`);
    try {
      const out = execFileSync(
        "xcrun",
        ["notarytool", "submit", zipPath, ...auth, "--wait", "--timeout", "20m"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
      );
      process.stdout.write(out);
      if (/status:\s*Accepted/.test(out)) {
        accepted = true;
      } else {
        console.warn(`[notarize] not accepted on attempt ${attempt}; response above.`);
        const idMatch = out.match(/id:\s*([0-9a-f-]{36})/i);
        if (idMatch) {
          try {
            const log = execFileSync("xcrun", ["notarytool", "log", idMatch[1], ...auth], {
              encoding: "utf8",
            });
            console.warn("[notarize] notary log:\n" + log);
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      // transient HTTP error / network — retry
      console.warn(
        `[notarize] attempt ${attempt} errored: ${err && err.message ? err.message.split("\n")[0] : err}`
      );
    }
    if (!accepted && attempt < MAX_ATTEMPTS) {
      console.log(`[notarize] retrying in ${RETRY_DELAY_MS / 1000}s…`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  if (!accepted) {
    throw new Error(`[notarize] notarization failed after ${MAX_ATTEMPTS} attempts`);
  }

  console.log(`[notarize] stapling ${appPath}`);
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("[notarize] done ✔");
};
