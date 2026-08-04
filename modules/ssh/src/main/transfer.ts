import * as node_crypto from "node:crypto";
import * as node_fs from "node:fs";
import * as node_path from "node:path";
import { pipeline } from "node:stream/promises";
import type { SshManager, SshSession } from "./ssh.js";

type EmitFn = (channel: string, payload: any) => void;
type TransferDirection = "upload" | "download";

type TransferJob = {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  source: string;
  destination: string;
  resume: boolean;
  state: "queued" | "running" | "completed" | "failed" | "canceled";
  transferred: number;
  total: number;
  cancel: (() => void) | null;
};

function callbackPromise<T>(invoke: (done: (error?: Error | null, value?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    invoke((error, value) => error ? reject(error) : resolve(value as T));
  });
}

function validateRemotePath(value: string) {
  if (!value || value.includes("\0")) throw new Error("Path remote tidak valid");
  return value;
}

function fileType(mode = 0) {
  const kind = mode & 0o170000;
  if (kind === 0o040000) return "directory";
  if (kind === 0o120000) return "symlink";
  return "file";
}

export class TransferManager {
  ssh: SshManager;
  emit: EmitFn;
  jobs = new Map<string, TransferJob>();
  queue: string[] = [];
  active = 0;
  maxConcurrent = 2;

  constructor(ssh: SshManager, emit: EmitFn) {
    this.ssh = ssh;
    this.emit = emit;
    this.ssh.onSessionEnd((sessionId) => this.cancelSession(sessionId));
  }

  requireSession(sessionId: string) {
    const session = this.ssh.getSession(sessionId);
    if (!session || session.status !== "connected") throw new Error("Sesi SSH tidak terhubung");
    return session;
  }

  openSftp(session: SshSession) {
    return callbackPromise<any>((done) => session.client.sftp(done));
  }

  async home(sessionId: string) {
    const sftp = await this.openSftp(this.requireSession(sessionId));
    try {
      return await callbackPromise<string>((done) => sftp.realpath(".", done));
    } finally {
      sftp.end();
    }
  }

  async list(sessionId: string, remotePath: string) {
    const path = validateRemotePath(remotePath);
    const sftp = await this.openSftp(this.requireSession(sessionId));
    try {
      const rows = await callbackPromise<any[]>((done) => sftp.readdir(path, done));
      return rows.map((row) => ({
        name: row.filename,
        path: node_path.posix.join(path, row.filename),
        type: fileType(row.attrs?.mode),
        size: row.attrs?.size ?? 0,
        mode: row.attrs?.mode ?? 0,
        modifiedAt: (row.attrs?.mtime ?? 0) * 1000
      })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
    } finally {
      sftp.end();
    }
  }

  async mkdir(sessionId: string, remotePath: string) {
    const sftp = await this.openSftp(this.requireSession(sessionId));
    try {
      await callbackPromise<void>((done) => sftp.mkdir(validateRemotePath(remotePath), { mode: 0o755 }, done));
    } finally {
      sftp.end();
    }
  }

  async rename(sessionId: string, from: string, to: string) {
    const sftp = await this.openSftp(this.requireSession(sessionId));
    try {
      await callbackPromise<void>((done) => sftp.rename(validateRemotePath(from), validateRemotePath(to), done));
    } finally {
      sftp.end();
    }
  }

  async remove(sessionId: string, remotePath: string, directory: boolean) {
    const sftp = await this.openSftp(this.requireSession(sessionId));
    try {
      await callbackPromise<void>((done) => directory
        ? sftp.rmdir(validateRemotePath(remotePath), done)
        : sftp.unlink(validateRemotePath(remotePath), done));
    } finally {
      sftp.end();
    }
  }

  enqueue(direction: TransferDirection, sessionId: string, source: string, destination: string, resume: boolean) {
    this.requireSession(sessionId);
    const id = node_crypto.randomUUID();
    const job: TransferJob = {
      id,
      sessionId,
      direction,
      source,
      destination,
      resume,
      state: "queued",
      transferred: 0,
      total: 0,
      cancel: null
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.publish(job);
    this.pump();
    return { transferId: id };
  }

  upload(sessionId: string, localPath: string, remotePath: string, resume = true) {
    const resolved = node_path.resolve(localPath);
    const stat = node_fs.statSync(resolved);
    if (!stat.isFile()) throw new Error("Upload saat ini hanya mendukung file");
    return this.enqueue("upload", sessionId, resolved, validateRemotePath(remotePath), resume);
  }

  download(sessionId: string, remotePath: string, localPath: string, resume = true) {
    const destination = node_path.resolve(localPath);
    node_fs.mkdirSync(node_path.dirname(destination), { recursive: true });
    return this.enqueue("download", sessionId, validateRemotePath(remotePath), destination, resume);
  }

  listJobs() {
    return [...this.jobs.values()].map(({ cancel: _cancel, ...job }) => job);
  }

  retry(transferId: string) {
    const job = this.jobs.get(transferId);
    if (!job || (job.state !== "failed" && job.state !== "canceled")) return false;
    if (job.direction === "upload" && !node_fs.existsSync(job.source)) throw new Error("File lokal tidak lagi tersedia");
    this.queue = this.queue.filter((id) => id !== transferId);
    job.state = "queued";
    job.transferred = 0;
    job.total = 0;
    job.cancel = null;
    this.queue.push(transferId);
    this.publish(job);
    this.pump();
    return true;
  }

  cancel(transferId: string) {
    const job = this.jobs.get(transferId);
    if (!job || job.state === "completed" || job.state === "failed" || job.state === "canceled") return false;
    job.state = "canceled";
    this.queue = this.queue.filter((id) => id !== transferId);
    job.cancel?.();
    this.publish(job);
    return true;
  }

  cancelSession(sessionId: string) {
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) this.cancel(job.id);
    }
  }

  publish(job: TransferJob, error?: string) {
    const { cancel: _cancel, ...payload } = job;
    this.emit("transfer:progress", { ...payload, error });
  }

  pump() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.state === "canceled") continue;
      this.active += 1;
      job.state = "running";
      this.publish(job);
      void this.run(job).then(() => {
        if (job.state !== "canceled") job.state = "completed";
        this.publish(job);
      }).catch((error) => {
        if (job.state !== "canceled") {
          job.state = "failed";
          this.publish(job, error instanceof Error ? error.message : String(error));
        }
      }).finally(() => {
        job.cancel = null;
        this.active -= 1;
        this.pump();
      });
    }
  }

  async run(job: TransferJob) {
    const session = this.requireSession(job.sessionId);
    const sftp = await this.openSftp(session);
    let input: any;
    let output: any;
    let lastPublish = 0;
    const update = (chunk: Buffer | string) => {
      job.transferred += Buffer.byteLength(chunk);
      const now = Date.now();
      if (now - lastPublish >= 100) {
        lastPublish = now;
        this.publish(job);
      }
    };
    try {
      if (job.direction === "download") {
        const attrs = await callbackPromise<any>((done) => sftp.stat(job.source, done));
        job.total = attrs.size ?? 0;
        let offset = 0;
        if (job.resume && node_fs.existsSync(job.destination)) {
          offset = node_fs.statSync(job.destination).size;
          if (offset > job.total) offset = 0;
        }
        job.transferred = offset;
        if (offset === job.total && job.total > 0) return;
        input = sftp.createReadStream(job.source, offset > 0 ? { start: offset } : undefined);
        output = node_fs.createWriteStream(job.destination, { flags: offset > 0 ? "a" : "w", mode: 0o600 });
      } else {
        const local = node_fs.statSync(job.source);
        job.total = local.size;
        let offset = 0;
        if (job.resume) {
          try {
            const attrs = await callbackPromise<any>((done) => sftp.stat(job.destination, done));
            if (attrs.size === job.total && job.total > 0) {
              job.transferred = job.total;
              return;
            }
            offset = attrs.size > 0 && attrs.size < job.total ? attrs.size : 0;
          } catch {
            offset = 0;
          }
        }
        job.transferred = offset;
        input = node_fs.createReadStream(job.source, offset > 0 ? { start: offset } : undefined);
        output = sftp.createWriteStream(job.destination, offset > 0 ? { flags: "r+", start: offset } : { flags: "w", mode: 0o600 });
      }
      input.on("data", update);
      job.cancel = () => {
        input?.destroy(new Error("Transfer dibatalkan"));
        output?.destroy(new Error("Transfer dibatalkan"));
        sftp.end();
      };
      await pipeline(input, output);
      job.transferred = job.total;
    } finally {
      input?.off("data", update);
      sftp.end();
    }
  }
}