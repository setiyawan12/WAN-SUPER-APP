import { spawn } from "node:child_process";
import { getRoot } from "../cowork-project.js";
import type { Tool } from "./types.js";
import { safeJsonArgs } from "./types.js";

// Destructive / privilege-escalation patterns (C5). Prefer fail-closed on match.
const BLOCKED = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\b/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b.*\//i,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\b:(){:|:&};:/, // classic fork bomb
  /\bcurl\b.+\|\s*(ba)?sh\b/i,
  /\bwget\b.+\|\s*(ba)?sh\b/i,
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\b/,
];

export function isBlockedCommand(command: string): boolean {
  return BLOCKED.some((re) => re.test(command));
}

export const runCommand: Tool = {
  name: "run_command",
  description:
    "Run a shell command with cwd set to the project root. Always requires approval. Prefer non-destructive commands.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
    },
    required: ["command"],
  },
  needsApproval: true,
  danger: true,
  prepareApproval(raw) {
    const args = safeJsonArgs(raw);
    const command = String(args.command ?? "");
    return {
      title: "Run command",
      detail: command,
      danger: true,
    };
  },
  async run(raw, { emit, signal }) {
    const args = safeJsonArgs(raw);
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("command is required");
    if (isBlockedCommand(command)) {
      throw new Error(`Blocked dangerous command pattern: ${command}`);
    }
    const cwd = getRoot();
    if (!cwd) throw new Error("No project selected");

    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, { cwd, shell: true, env: process.env });
      let out = "";
      const push = (b: Buffer | string) => {
        out += String(b);
        emit({ output: out.slice(-8000), summary: `run: ${command}` });
      };
      child.stdout.on("data", push);
      child.stderr.on("data", push);

      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve(`exit (timeout 120s)\n${out.slice(-12000)}`);
      }, 120_000);

      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          resolve(`aborted\n${out.slice(-12000)}`);
          return;
        }
        emit({ summary: `run: ${command} → exit ${code}` });
        resolve(`exit ${code}\n${out.slice(-12000)}`);
      });
    });
  },
};

export const RUN_TOOLS: Tool[] = [runCommand];
