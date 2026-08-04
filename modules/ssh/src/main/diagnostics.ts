import * as node_dns from "node:dns";
import * as node_net from "node:net";
import { SSH } from "./constants.js";
import { itemRepo } from "./repo.js";
import type { SshManager } from "./ssh.js";

type Phase = {
  name: "resolve" | "tcp" | "ssh";
  ok: boolean;
  durationMs: number;
  detail: string;
};

async function resolveHost(address: string) {
  const started = Date.now();
  try {
    const rows = await node_dns.promises.lookup(address, { all: true });
    return {
      name: "resolve",
      ok: true,
      durationMs: Date.now() - started,
      detail: rows.map((row) => row.address).join(", ") || address
    } as Phase;
  } catch (error) {
    return {
      name: "resolve",
      ok: false,
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error)
    } as Phase;
  }
}

function tcpProbe(address: string, port: number) {
  const started = Date.now();
  return new Promise<Phase>((resolve) => {
    const socket = node_net.createConnection({ host: address, port });
    const finish = (ok: boolean, detail: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ name: "tcp", ok, durationMs: Date.now() - started, detail });
    };
    socket.setTimeout(Math.min(SSH.readyTimeoutMs, 10_000));
    socket.once("connect", () => finish(true, `${address}:${port} menerima koneksi TCP`));
    socket.once("timeout", () => finish(false, "TCP timeout"));
    socket.once("error", (error) => finish(false, error.message));
  });
}

export class DiagnosticsService {
  ssh: SshManager;

  constructor(ssh: SshManager) {
    this.ssh = ssh;
  }

  async run(hostId: string) {
    const host = itemRepo.get(hostId);
    if (!host || host.type !== "host") throw new Error("Host tidak ditemukan");
    const phases: Phase[] = [];
    const probeHost = host.jumpHostId ? itemRepo.get(host.jumpHostId) : host;
    if (!probeHost || probeHost.type !== "host") throw new Error("Jump host tidak ditemukan");
    const resolved = await resolveHost(probeHost.address);
    if (host.jumpHostId && resolved.ok) resolved.detail = `Bastion ${probeHost.address}: ${resolved.detail}`;
    phases.push(resolved);
    if (!resolved.ok) return this.result(host, phases);
    const tcp = await tcpProbe(probeHost.address, probeHost.port ?? SSH.defaultPort);
    if (host.jumpHostId && tcp.ok) tcp.detail = "Bastion ready; target will be reached through SSH forwarding";
    phases.push(tcp);
    if (!tcp.ok) return this.result(host, phases);
    const started = Date.now();
    const ssh = await this.ssh.testConnection(hostId);
    phases.push({
      name: "ssh",
      ok: ssh.ok,
      durationMs: Date.now() - started,
      detail: ssh.ok ? `Handshake, autentikasi, dan shell siap (${ssh.latencyMs} ms)` : ssh.error ?? "SSH gagal"
    });
    return this.result(host, phases);
  }

  result(host: any, phases: Phase[]) {
    return {
      hostId: host.id,
      address: host.address,
      port: host.port ?? SSH.defaultPort,
      ok: phases.every((phase) => phase.ok),
      phases,
      checkedAt: Date.now()
    };
  }
}