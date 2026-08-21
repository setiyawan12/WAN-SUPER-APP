import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OverlayProbe = {
  installed: boolean;
  running: boolean;
  ip?: string;
  detail?: string;
};

export type OverlayStatus = {
  tailscale: OverlayProbe;
  wireguard: OverlayProbe;
  tunnelInterfaces: string[];
};

const TUNNEL_NAME = /^(tailscale\d*|wg\d*|utun\d*|tun\d*|ppp\d*|ipsec\d*|zt\d*|tailscale)/i;

function interfaceNames() {
  return Object.entries(networkInterfaces())
    .filter(([, addresses]) => addresses?.some((entry) => !entry.internal))
    .map(([name]) => name);
}

function firstIpv4(name: string) {
  return networkInterfaces()[name]?.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
}

async function run(command: string, args: string[]) {
  try {
    const result = await execFileAsync(command, args, { timeout: 1_500, windowsHide: true, maxBuffer: 64 * 1024 });
    return { ok: true, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const err = error as { code?: string | number; stdout?: string; stderr?: string };
    if (err.code === "ENOENT") return { ok: false, missing: true, stdout: "", stderr: "" };
    return { ok: false, missing: false, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

async function probeTailscale(tunnels: string[]): Promise<OverlayProbe> {
  const status = await run("tailscale", ["status", "--json"]);
  if (status.missing) {
    const named = tunnels.find((name) => /^tailscale/i.test(name));
    return named
      ? { installed: false, running: true, ip: firstIpv4(named), detail: named }
      : { installed: false, running: false };
  }
  if (!status.ok) return { installed: true, running: false, detail: "tailscale status failed" };
  try {
    const parsed = JSON.parse(status.stdout) as { Self?: { TailscaleIPs?: string[]; Online?: boolean }; BackendState?: string };
    const ip = parsed.Self?.TailscaleIPs?.find((value) => value.includes(".")) ?? parsed.Self?.TailscaleIPs?.[0];
    const running = parsed.BackendState === "Running" || parsed.Self?.Online === true || Boolean(ip);
    return { installed: true, running, ip, detail: parsed.BackendState };
  } catch {
    return { installed: true, running: false, detail: "tailscale status unreadable" };
  }
}

async function probeWireGuard(tunnels: string[]): Promise<OverlayProbe> {
  const named = tunnels.filter((name) => /^wg/i.test(name));
  const show = await run("wg", ["show"]);
  if (show.missing) {
    return named.length
      ? { installed: false, running: true, ip: firstIpv4(named[0]), detail: named.join(",") }
      : { installed: false, running: false };
  }
  const running = show.ok && Boolean(show.stdout.trim()) || named.length > 0;
  return { installed: true, running, ip: named[0] ? firstIpv4(named[0]) : undefined, detail: named[0] };
}

export async function detectOverlays(): Promise<OverlayStatus> {
  const tunnelInterfaces = interfaceNames().filter((name) => TUNNEL_NAME.test(name));
  const [tailscale, wireguard] = await Promise.all([probeTailscale(tunnelInterfaces), probeWireGuard(tunnelInterfaces)]);
  return { tailscale, wireguard, tunnelInterfaces };
}
