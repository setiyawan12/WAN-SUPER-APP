/**
 * Headless functional smoke test for WAN Super App.
 * Boots each module through its adapter (show:false, no windows) and probes
 * real runtime behavior: cliproxy backend health, NET inspector, and a live
 * cloudflared quick-tunnel round-trip. Run via: electron scripts/functional-test.mjs
 */
import { app } from "electron";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(__dirname);
const require = createRequire(import.meta.url);

const results = [];
function log(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`[TEST] ${ok ? "PASS" : "FAIL"} — ${step}${detail ? " :: " + detail : ""}`);
}

function get(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
  });
}

async function poll(fn, tries = 30, gap = 500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, gap));
    }
  }
  throw last;
}

app.disableHardwareAcceleration?.();

app.whenReady().then(async () => {
  // ── local origin server the tunnel will point at ─────────────────────────
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("WAN-SUPER-APP-ORIGIN-OK");
  });
  const originPort = await new Promise((resolve) => {
    origin.listen(0, "127.0.0.1", () => resolve(origin.address().port));
  });
  log("local origin server up", true, `127.0.0.1:${originPort}`);

  // ── 1) CLIProxyAPI module ────────────────────────────────────────────────
  let cliproxyPort = 4317;
  try {
    const bootUrl = pathToFileURL(
      path.join(root, "out/modules/cliproxy/main/super-boot.js")
    ).href;
    const mod = await import(bootUrl);
    const h = await mod.bootCliproxy({ show: false });
    cliproxyPort = Number(process.env.PORT || 4317);
    const res = await poll(() => get(`http://127.0.0.1:${cliproxyPort}/`));
    let ok = false;
    try {
      ok = JSON.parse(res.body).status === "ok";
    } catch {}
    log("cliproxy backend health", ok, `:${cliproxyPort} ${res.body.slice(0, 60)}`);
    const api = await get(`http://127.0.0.1:${cliproxyPort}/api/health`).catch((e) => ({
      status: "ERR",
      body: e.message,
    }));
    log("cliproxy /api reachable", api.status !== "ERR", `status=${api.status}`);
    log("cliproxy isRunning()", h.isRunning() === true, JSON.stringify(h.getStatus()));
  } catch (e) {
    log("cliproxy backend health", false, e.message);
  }

  // ── 2) WAN NET module ────────────────────────────────────────────────────
  let net;
  try {
    net = require(path.join(root, "out/modules/net/adapter/boot.cjs"));
    const h = await net.bootNet({ show: false });
    const st = h.getStatus();
    log("net initRuntime + getStatus", !!st, JSON.stringify(st));
    const insp = st.inspPort;
    if (insp) {
      const res = await poll(() => get(`http://localhost:${insp}/`));
      log("net inspector dashboard", res.status === 200, `:${insp} status=${res.status}`);
    } else {
      log("net inspector dashboard", false, "no inspPort");
    }
  } catch (e) {
    log("net initRuntime + getStatus", false, e.message);
  }

  // ── 3) Live cloudflared quick tunnel round-trip (needs egress) ────────────
  try {
    const netMain = require(path.join(root, "out/modules/net/electron/main.js"));
    const state = require(path.join(root, "out/modules/net/lib/state.js"));
    const started = await netMain.startTunnel(originPort, {});
    log("net startTunnel() accepted", !!(started && started.ok), JSON.stringify(started));

    // URL arrives asynchronously via cloudflared's onURL callback (Quick Tunnel).
    const key = String(originPort);
    let url = null;
    for (let i = 0; i < 40; i++) {
      const entry = state.tunnels.get(key);
      if (entry && entry.publicUrl) { url = entry.publicUrl; break; }
      if (netMain.getStatus().liveTunnels >= 1 && entry && entry.publicUrl) { url = entry.publicUrl; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    log("cloudflared quick tunnel URL live", !!url && /^https:\/\//.test(String(url)), String(url || "no URL within 60s (cloudflared egress?)"));

    if (url && url.startsWith("http")) {
      const https = require("node:https");
      const pub = await poll(() => new Promise((resolve, reject) => {
        const r = https.get(url, (res) => {
          let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
        });
        r.on("error", reject);
        r.setTimeout(8000, () => r.destroy(new Error("timeout")));
      }), 12, 2500);
      log("public URL round-trip → origin", pub.body.includes("WAN-SUPER-APP-ORIGIN-OK"), `status=${pub.status} body="${pub.body.slice(0,40)}"`);
    }
  } catch (e) {
    log("cloudflared quick tunnel URL live", false, e && e.message);
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[TEST] SUMMARY ${pass}/${results.length} passed`);
  console.log("[TEST] JSON " + JSON.stringify(results));

  setTimeout(() => app.exit(pass === results.length ? 0 : 2), 500);
});
