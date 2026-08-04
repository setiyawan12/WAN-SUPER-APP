import * as node_fs from "node:fs";
import * as node_path from "node:path";

const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
const SECRET_PATTERN = /((?:password|passphrase|token|secret|api[_-]?key)\s*[:=]\s*)([^\s\r\n]+)/gi;

export function redactTerminalText(value: string) {
  return value.replace(SECRET_PATTERN, "$1[REDACTED]");
}

type Recording = {
  sessionId: string;
  startedAt: number;
  includeInput: boolean;
  bytes: number;
  truncated: boolean;
  lines: string[];
};

export class RecordingManager {
  recordings = new Map<string, Recording>();

  start(sessionId: string, cols: number, rows: number, includeInput = false) {
    if (this.recordings.has(sessionId)) throw new Error("Recording sesi ini sudah aktif");
    const startedAt = Date.now();
    const header = JSON.stringify({
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(startedAt / 1000),
      env: { TERM: "xterm-256color", SHELL: "ssh" }
    });
    this.recordings.set(sessionId, {
      sessionId,
      startedAt,
      includeInput,
      bytes: Buffer.byteLength(header) + 1,
      truncated: false,
      lines: [header]
    });
    return this.status(sessionId);
  }

  status(sessionId?: string) {
    if (sessionId) {
      const recording = this.recordings.get(sessionId);
      return recording ? this.view(recording) : null;
    }
    return [...this.recordings.values()].map((recording) => this.view(recording));
  }

  view(recording: Recording) {
    return {
      sessionId: recording.sessionId,
      startedAt: recording.startedAt,
      includeInput: recording.includeInput,
      bytes: recording.bytes,
      truncated: recording.truncated
    };
  }

  captureOutput(sessionId: string, data: string) {
    this.capture(sessionId, "o", data);
  }

  captureInput(sessionId: string, data: string) {
    const recording = this.recordings.get(sessionId);
    if (recording?.includeInput) this.capture(sessionId, "i", data);
  }

  capture(sessionId: string, stream: "i" | "o", data: string) {
    const recording = this.recordings.get(sessionId);
    if (!recording || recording.truncated) return;
    const elapsed = Math.max(0, (Date.now() - recording.startedAt) / 1000);
    const line = JSON.stringify([Number(elapsed.toFixed(6)), stream, redactTerminalText(data)]);
    const bytes = Buffer.byteLength(line) + 1;
    if (recording.bytes + bytes > MAX_RECORDING_BYTES) {
      const marker = JSON.stringify([Number(elapsed.toFixed(6)), "o", "\r\n[recording truncated at 25 MiB]\r\n"]);
      recording.lines.push(marker);
      recording.bytes += Buffer.byteLength(marker) + 1;
      recording.truncated = true;
      return;
    }
    recording.lines.push(line);
    recording.bytes += bytes;
  }

  stop(sessionId: string) {
    const recording = this.recordings.get(sessionId);
    if (!recording) throw new Error("Recording tidak aktif");
    this.recordings.delete(sessionId);
    return recording;
  }

  restore(recording: Recording) {
    this.recordings.set(recording.sessionId, recording);
  }

  save(recording: Recording, filePath: string) {
    const destination = node_path.resolve(filePath);
    node_fs.mkdirSync(node_path.dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp`;
    node_fs.writeFileSync(temporary, `${recording.lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    node_fs.renameSync(temporary, destination);
    try {
      node_fs.chmodSync(destination, 0o600);
    } catch {
    }
    return { filePath: destination, bytes: recording.bytes, truncated: recording.truncated };
  }

  discard(sessionId: string) {
    return this.recordings.delete(sessionId);
  }

  discardAll() {
    this.recordings.clear();
  }
}