import * as node_crypto from "node:crypto";
import * as node_fs from "node:fs";
import * as node_os from "node:os";
import * as node_path from "node:path";
import * as node_pty from "node-pty";

type EmitFn = (channel: string, payload: any) => void;

function defaultShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  const configured = process.env.SHELL;
  if (configured && node_path.isAbsolute(configured) && node_fs.existsSync(configured)) return configured;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function shellArgs(shell: string) {
  if (process.platform === "win32") return /powershell|pwsh/i.test(shell) ? ["-NoLogo"] : [];
  return ["-l"];
}

function ptyEnvironment() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

export class LocalSession {
  id = node_crypto.randomUUID();
  process: node_pty.IPty;
  emit: EmitFn;
  onEnd: (sessionId: string) => void;
  dataSubscription: node_pty.IDisposable;
  exitSubscription: node_pty.IDisposable;
  ended = false;
  pty = true;

  constructor(input: any, emit: EmitFn, onEnd: (sessionId: string) => void) {
    this.emit = emit;
    this.onEnd = onEnd;
    const shell = input.shell || defaultShell();
    const cwd = input.cwd ? node_path.resolve(input.cwd) : node_os.homedir();
    if (!node_fs.existsSync(cwd) || !node_fs.statSync(cwd).isDirectory()) throw new Error("Folder local shell tidak ditemukan");
    this.emit("session:state", { sessionId: this.id, state: "connecting", local: true });
    this.process = node_pty.spawn(shell, shellArgs(shell), {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd,
      env: ptyEnvironment(),
      ...(process.platform === "win32" ? { useConpty: true } : {})
    });
    this.dataSubscription = this.process.onData((data) => {
      this.emit("term:output", { sessionId: this.id, data });
    });
    this.exitSubscription = this.process.onExit(({ exitCode, signal }) => {
      this.finish(exitCode ?? 0, signal ? `signal-${signal}` : "process-exit");
    });
    this.emit("session:state", { sessionId: this.id, state: "connected", local: true, pty: true });
  }

  write(data: string) {
    if (!this.ended) this.process.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.ended) this.process.resize(cols, rows);
  }

  close(reason = "user-closed") {
    if (this.ended) return;
    try {
      this.process.kill();
    } catch {
    }
    this.finish(0, reason);
  }

  finish(code: number, reason: string, message?: string) {
    if (this.ended) return;
    this.ended = true;
    this.dataSubscription.dispose();
    this.exitSubscription.dispose();
    this.emit("session:state", { sessionId: this.id, state: "disconnected", reason, message, local: true });
    this.emit("term:exit", { sessionId: this.id, code, reason, message });
    this.onEnd(this.id);
  }
}

export class LocalSessionManager {
  emit: EmitFn;
  sessions = new Map<string, LocalSession>();

  constructor(emit: EmitFn) {
    this.emit = emit;
  }

  open(input: any) {
    const session = new LocalSession(input, this.emit, (sessionId) => this.sessions.delete(sessionId));
    this.sessions.set(session.id, session);
    return { sessionId: session.id, pty: true };
  }

  has(sessionId: string) {
    return this.sessions.has(sessionId);
  }

  write(sessionId: string, data: string) {
    this.sessions.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number) {
    this.sessions.get(sessionId)?.resize(cols, rows);
  }

  close(sessionId: string, reason = "user-closed") {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.close(reason);
  }

  closeAll(reason: string) {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.close(reason);
  }
}