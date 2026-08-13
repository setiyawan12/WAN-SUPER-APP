import * as node_crypto from "node:crypto";
import * as node_net from "node:net";
import type { SshManager, SshSession } from "./ssh.js";

type EmitFn = (channel: string, payload: any) => void;
type TunnelKind = "local" | "remote" | "dynamic";

type TunnelView = {
  id: string;
  sessionId: string;
  kind: TunnelKind;
  label: string;
  bindAddress: string;
  bindPort: number;
  targetHost?: string;
  targetPort?: number;
  state: "active" | "reconnecting" | "stopping" | "error";
  error?: string;
};

type TunnelRecord = TunnelView & {
  stop: () => Promise<void>;
};

function callbackPromise<T>(invoke: (done: (error?: Error | null, value?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    invoke((error, value) => error ? reject(error) : resolve(value as T));
  });
}

function listen(server: node_net.Server, port: number, host: string) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: node_net.Server, sockets: Set<node_net.Socket>) {
  return new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function ipv6Address(buffer: Buffer) {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) groups.push(buffer.readUInt16BE(offset).toString(16));
  return groups.join(":");
}

function socksReply(socket: node_net.Socket, status: number) {
  socket.write(Buffer.from([5, status, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function handleSocksConnection(socket: node_net.Socket, session: SshSession) {
  let buffer = Buffer.alloc(0);
  let stage: "greeting" | "request" | "connected" = "greeting";

  const fail = (status = 1) => {
    if (!socket.destroyed) socksReply(socket, status);
    socket.end();
  };

  const parse = () => {
    if (stage === "greeting") {
      if (buffer.length < 2) return;
      if (buffer[0] !== 5) return socket.end();
      const methodsLength = buffer[1];
      if (buffer.length < 2 + methodsLength) return;
      const methods = buffer.subarray(2, 2 + methodsLength);
      buffer = buffer.subarray(2 + methodsLength);
      if (methods.includes(0) && methodsLength > 0) socket.write(Buffer.from([5, 0]));
      else {
        socket.write(Buffer.from([5, 255]));
        return socket.end();
      }
      stage = "request";
    }
    if (stage !== "request" || buffer.length < 4) return;
    const version = buffer[0];
    const command = buffer[1];
    const addressType = buffer[3];
    let offset = 4;
    let host = "";
    if (version !== 5 || command !== 1) return fail(command === 1 ? 1 : 7);
    if (addressType === 1) {
      if (buffer.length < 10) return;
      host = [...buffer.subarray(offset, offset + 4)].join(".");
      offset += 4;
    } else if (addressType === 3) {
      if (buffer.length < 5) return;
      const length = buffer[offset++];
      if (buffer.length < offset + length + 2) return;
      host = buffer.subarray(offset, offset + length).toString("utf8");
      offset += length;
    } else if (addressType === 4) {
      if (buffer.length < 22) return;
      host = ipv6Address(buffer.subarray(offset, offset + 16));
      offset += 16;
    } else {
      return fail(8);
    }
    if (buffer.length < offset + 2) return;
    const port = buffer.readUInt16BE(offset);
    const remaining = buffer.subarray(offset + 2);
    stage = "connected";
    socket.off("data", onData);
    session.client.forwardOut(
      socket.remoteAddress ?? "127.0.0.1",
      socket.remotePort ?? 0,
      host,
      port,
      (error: Error | undefined, stream: any) => {
        if (error) return fail(5);
        socksReply(socket, 0);
        if (remaining.length) stream.write(remaining);
        socket.pipe(stream).pipe(socket);
        stream.on("error", () => socket.destroy());
        socket.on("error", () => stream.destroy());
      }
    );
  };

  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 66_000) return fail(1);
    parse();
  };
  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
}

export class TunnelManager {
  ssh: SshManager;
  emit: EmitFn;
  tunnels = new Map<string, TunnelRecord>();
  remoteHandlers = new Map<string, (...args: any[]) => void>();

  constructor(ssh: SshManager, emit: EmitFn) {
    this.ssh = ssh;
    this.emit = emit;
    this.ssh.onSessionEnd((sessionId, event) => void (event.reconnecting ? this.suspendSession(sessionId) : this.stopSession(sessionId)));
    this.ssh.onSessionReady((sessionId) => void this.restoreSession(sessionId));
  }

  requireSession(sessionId: string) {
    const session = this.ssh.getSession(sessionId);
    if (!session || session.status !== "connected") throw new Error("Sesi SSH tidak terhubung");
    return session;
  }

  list(sessionId?: string) {
    return [...this.tunnels.values()]
      .filter((tunnel) => !sessionId || tunnel.sessionId === sessionId)
      .map(({ stop: _stop, ...view }) => view);
  }

  publish() {
    this.emit("tunnel:changed", this.list());
  }

  async start(input: any) {
    const session = this.requireSession(input.sessionId);
    if (input.kind === "local") return this.startLocal(session, input);
    if (input.kind === "remote") return this.startRemote(session, input);
    return this.startDynamic(session, input);
  }

  async startLocal(session: SshSession, input: any, id?: string) {
    const sockets = new Set<node_net.Socket>();
    const server = node_net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      session.client.forwardOut(
        socket.remoteAddress ?? "127.0.0.1",
        socket.remotePort ?? 0,
        input.targetHost,
        input.targetPort,
        (error: Error | undefined, stream: any) => {
          if (error) return socket.destroy(error);
          socket.pipe(stream).pipe(socket);
          stream.on("error", () => socket.destroy());
          socket.on("error", () => stream.destroy());
        }
      );
    });
    const bindAddress = input.bindAddress || "127.0.0.1";
    const bindPort = await listen(server, input.bindPort ?? 0, bindAddress);
    return this.add({
      sessionId: session.id,
      kind: "local",
      label: input.label || `L ${bindPort} -> ${input.targetHost}:${input.targetPort}`,
      bindAddress,
      bindPort,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      stop: () => closeServer(server, sockets)
    }, id);
  }

  ensureRemoteHandler(session: SshSession) {
    if (this.remoteHandlers.has(session.id)) return;
    const handler = (info: any, accept: () => any, reject: () => void) => {
      const tunnel = [...this.tunnels.values()].find((candidate) =>
        candidate.sessionId === session.id
        && candidate.kind === "remote"
        && candidate.bindPort === info.destPort
      );
      if (!tunnel || !tunnel.targetHost || !tunnel.targetPort) return reject();
      const local = node_net.createConnection(tunnel.targetPort, tunnel.targetHost);
      const onError = () => {
        reject();
        local.destroy();
      };
      local.once("connect", () => {
        local.off("error", onError);
        const stream = accept();
        local.pipe(stream).pipe(local);
        stream.on("error", () => local.destroy());
      });
      local.once("error", onError);
    };
    session.client.on("tcp connection", handler);
    this.remoteHandlers.set(session.id, handler);
  }

  async startRemote(session: SshSession, input: any, id?: string) {
    const bindAddress = input.bindAddress || "127.0.0.1";
    const requestedPort = input.bindPort ?? 0;
    const bindPort = await callbackPromise<number>((done) => session.client.forwardIn(bindAddress, requestedPort, done));
    this.ensureRemoteHandler(session);
    return this.add({
      sessionId: session.id,
      kind: "remote",
      label: input.label || `R ${bindPort} -> ${input.targetHost}:${input.targetPort}`,
      bindAddress,
      bindPort,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      stop: async () => {
        await callbackPromise<void>((done) => session.client.unforwardIn(bindAddress, bindPort, done));
      }
    }, id);
  }

  async startDynamic(session: SshSession, input: any, id?: string) {
    const sockets = new Set<node_net.Socket>();
    const server = node_net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      handleSocksConnection(socket, session);
    });
    const bindAddress = input.bindAddress || "127.0.0.1";
    const bindPort = await listen(server, input.bindPort ?? 0, bindAddress);
    return this.add({
      sessionId: session.id,
      kind: "dynamic",
      label: input.label || `SOCKS5 ${bindAddress}:${bindPort}`,
      bindAddress,
      bindPort,
      stop: () => closeServer(server, sockets)
    }, id);
  }

  add(input: Omit<TunnelRecord, "id" | "state">, id: string = node_crypto.randomUUID()) {
    const tunnel: TunnelRecord = {
      id,
      state: "active",
      ...input
    };
    this.tunnels.set(tunnel.id, tunnel);
    this.publish();
    return this.list(tunnel.sessionId).find((view) => view.id === tunnel.id)!;
  }

  async suspendSession(sessionId: string) {
    const records = [...this.tunnels.values()].filter((tunnel) => tunnel.sessionId === sessionId);
    for (const tunnel of records) tunnel.state = "reconnecting";
    this.publish();
    await Promise.allSettled(records.map(async (tunnel) => {
      if (tunnel.kind !== "remote") await tunnel.stop();
      tunnel.stop = async () => undefined;
    }));
    this.cleanupRemoteHandler(sessionId, true);
  }

  async restoreSession(sessionId: string) {
    const session = this.requireSession(sessionId);
    const records = [...this.tunnels.values()].filter((tunnel) => tunnel.sessionId === sessionId && tunnel.state === "reconnecting");
    for (const tunnel of records) {
      const input = {
        sessionId,
        kind: tunnel.kind,
        label: tunnel.label,
        bindAddress: tunnel.bindAddress,
        bindPort: tunnel.bindPort,
        targetHost: tunnel.targetHost,
        targetPort: tunnel.targetPort
      };
      try {
        if (tunnel.kind === "local") await this.startLocal(session, input, tunnel.id);
        else if (tunnel.kind === "remote") await this.startRemote(session, input, tunnel.id);
        else await this.startDynamic(session, input, tunnel.id);
      } catch (error) {
        tunnel.state = "error";
        tunnel.error = error instanceof Error ? error.message : String(error);
        this.tunnels.set(tunnel.id, tunnel);
        this.publish();
      }
    }
  }

  async stop(id: string) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;
    tunnel.state = "stopping";
    this.publish();
    try {
      await tunnel.stop();
    } finally {
      this.tunnels.delete(id);
      this.cleanupRemoteHandler(tunnel.sessionId);
      this.publish();
    }
    return true;
  }

  async stopSession(sessionId: string) {
    const ids = [...this.tunnels.values()].filter((tunnel) => tunnel.sessionId === sessionId).map((tunnel) => tunnel.id);
    await Promise.allSettled(ids.map((id) => this.stop(id)));
    this.cleanupRemoteHandler(sessionId, true);
  }

  cleanupRemoteHandler(sessionId: string, force = false) {
    if (!force && [...this.tunnels.values()].some((tunnel) => tunnel.sessionId === sessionId && tunnel.kind === "remote")) return;
    const handler = this.remoteHandlers.get(sessionId);
    const session = this.ssh.getSession(sessionId);
    if (handler && session) session.client.off("tcp connection", handler);
    this.remoteHandlers.delete(sessionId);
  }
}