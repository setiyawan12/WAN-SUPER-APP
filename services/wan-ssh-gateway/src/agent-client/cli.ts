#!/usr/bin/env node
import { AgentRunner, type AgentLogger } from "./agent.js";
import { clearStore, decodePairing, readStore, storePath, writeStore, type AgentStore } from "./pairing.js";
import { createEgressPolicy } from "./policy.js";
import { createTokenSource } from "./token.js";

type Flags = { values: Map<string, string>; switches: Set<string>; positionals: string[] };

const USAGE = `wan-ssh-agent — bridge WAN SSH gateway sessions through this machine's network (VPN included).

Usage
  wan-ssh-agent pair <code> [--allow <cidr,...>] [--allow-loopback]
  wan-ssh-agent run [--pair <code>] [--url <gateway>] [--dev-anonymous] [--allow <cidr,...>] [--allow-loopback] [--once]
  wan-ssh-agent status
  wan-ssh-agent unpair

Options
  --allow <cidr,...>   Only allow targets inside these CIDRs, e.g. 10.8.0.0/24,192.168.10.0/24
  --allow-loopback     Permit 127.0.0.0/8 targets (off by default; enable only for local testing)
  --url <gateway>      Gateway origin, e.g. https://ssh.example.com (defaults to the paired URL)
  --dev-anonymous      Register without Firebase, for a gateway running in development auth mode
  --once               Exit instead of reconnecting when the gateway connection drops

Get the pairing code from the web UI: account menu -> "Local agent".
The pairing file lives at ${storePath()} and is written with mode 0600.`;

function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (inline !== undefined) values.set(name, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) values.set(name, argv[(index += 1)]);
    else switches.add(name);
  }
  return { values, switches, positionals };
}

function cidrsOf(flags: Flags, fallback?: string[]) {
  const raw = flags.values.get("allow");
  if (raw === undefined) return fallback;
  const list = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function createLogger(): AgentLogger {
  return (level, message, fields) => {
    const stamp = new Date().toISOString().slice(11, 19);
    const extra = fields
      ? Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}=${value}`).join("")
      : "";
    const line = `[${stamp}] ${level.padEnd(5)} ${message}${extra}`;
    if (level === "error") console.error(line);
    else console.log(line);
  };
}

function requireStore(): AgentStore {
  const store = readStore();
  if (!store) throw new Error(`No pairing found at ${storePath()}. Run \`wan-ssh-agent pair <code>\` first.`);
  return store;
}

function pairCommand(flags: Flags) {
  const code = flags.positionals[0];
  if (!code) throw new Error("Provide the pairing code from the web UI: wan-ssh-agent pair <code>");
  const pairing = decodePairing(code);
  const store: AgentStore = { ...pairing, pairedAt: Date.now() };
  const allowCidrs = cidrsOf(flags);
  if (allowCidrs) store.allowCidrs = allowCidrs;
  if (flags.switches.has("allow-loopback")) store.allowLoopback = true;
  createEgressPolicy({ allowCidrs: store.allowCidrs, allowLoopback: store.allowLoopback });
  const path = writeStore(store);
  console.log(`Paired with ${pairing.url}${pairing.account ? ` as ${pairing.account}` : ""}.`);
  console.log(`Stored at ${path} (mode 0600).`);
  if (!store.allowCidrs) console.log("No target allowlist is set. Consider `--allow 10.0.0.0/8` so the agent only reaches your VPN range.");
  console.log("Start it with: wan-ssh-agent run");
}

function statusCommand() {
  const store = readStore();
  if (!store) {
    console.log(`No pairing found at ${storePath()}.`);
    return;
  }
  console.log(`Gateway:    ${store.url}`);
  console.log(`Auth mode:  ${store.mode}${store.account ? ` (${store.account})` : ""}`);
  console.log(`Allowlist:  ${store.allowCidrs?.join(", ") ?? "none (every routable target is permitted)"}`);
  console.log(`Loopback:   ${store.allowLoopback ? "allowed" : "blocked"}`);
  console.log(`Paired at:  ${store.pairedAt ? new Date(store.pairedAt).toISOString() : "unknown"}`);
  console.log(`Store:      ${storePath()}`);
}

function runCommand(flags: Flags) {
  const inline = flags.values.get("pair");
  if (inline) pairCommand({ ...flags, positionals: [inline] });
  const devAnonymous = flags.switches.has("dev-anonymous");
  const url = flags.values.get("url") ?? process.env.WAN_SSH_AGENT_URL;
  const store: AgentStore = devAnonymous && url
    ? { v: 1, url, mode: "dev-anonymous" }
    : { ...requireStore(), ...(url ? { url } : {}) };
  const allowCidrs = cidrsOf(flags, store.allowCidrs);
  const allowLoopback = flags.switches.has("allow-loopback") || Boolean(store.allowLoopback);
  const log = createLogger();
  const runner = new AgentRunner({
    url: store.url,
    tokens: createTokenSource(store),
    policy: createEgressPolicy({ allowCidrs, allowLoopback }),
    log,
    reconnect: !flags.switches.has("once"),
    onStopped: (reason) => {
      log("info", reason);
      process.exitCode = 0;
    }
  });
  log("info", "Starting the WAN SSH local agent", { gateway: store.url, mode: store.mode });
  log("info", allowCidrs?.length ? `Targets limited to ${allowCidrs.join(", ")}` : "No target allowlist is set");
  runner.start();
  const shutdown = (signal: string) => {
    log("info", `Received ${signal}, shutting down`);
    runner.stop("Agent stopped by operator");
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function main(argv: string[]) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "pair": return pairCommand(flags);
    case "run": return runCommand(flags);
    case "status": return statusCommand();
    case "unpair": {
      console.log(`Removed ${clearStore()}.`);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      console.log(USAGE);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
