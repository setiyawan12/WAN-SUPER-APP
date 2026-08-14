import { Resolver } from "node:dns/promises";
import { BlockList, Socket, isIP } from "node:net";
import type { GatewayConfig } from "../config.js";
import { GatewayError } from "../errors.js";
import { normalizeIp } from "../security/net.js";

export type ResolvedTarget = {
  originalHost: string;
  address: string;
  family: 4 | 6;
  port: number;
};

const forbidden = new BlockList();
forbidden.addSubnet("0.0.0.0", 8, "ipv4");
forbidden.addSubnet("127.0.0.0", 8, "ipv4");
forbidden.addSubnet("169.254.0.0", 16, "ipv4");
forbidden.addSubnet("224.0.0.0", 4, "ipv4");
forbidden.addSubnet("::", 128, "ipv6");
forbidden.addSubnet("::1", 128, "ipv6");
forbidden.addSubnet("fe80::", 10, "ipv6");
forbidden.addSubnet("ff00::", 8, "ipv6");

function cidrList(cidrs: string[]) {
  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText] = cidr.split("/");
    blockList.addSubnet(address, Number(prefixText), isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return blockList;
}

function addressType(family: 4 | 6) {
  return family === 4 ? "ipv4" : "ipv6";
}

export async function resolveTarget(
  config: GatewayConfig,
  host: string,
  port: number,
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>> = async (hostname) => {
    const resolver = new Resolver();
    const [ipv4, ipv6] = await Promise.all([
      resolver.resolve4(hostname).catch(() => []),
      resolver.resolve6(hostname).catch(() => [])
    ]);
    return [
      ...ipv4.map((address) => ({ address, family: 4 })),
      ...ipv6.map((address) => ({ address, family: 6 }))
    ];
  }
): Promise<ResolvedTarget> {
  if (config.environment === "production" && port !== 22) {
    throw new GatewayError("TARGET_DENIED", "Target port is not allowed");
  }
  let addresses: Array<{ address: string; family: number }>;
  const literalFamily = isIP(host);
  try {
    addresses = literalFamily ? [{ address: host, family: literalFamily }] : await lookup(host);
  } catch {
    throw new GatewayError("SSH_CONNECTION_FAILED", "Target hostname could not be resolved", true);
  }
  const normalized = addresses.filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6);
  if (!normalized.length) throw new GatewayError("SSH_CONNECTION_FAILED", "Target hostname returned no addresses", true);

  const allowlist = cidrList(config.egressAllowCidrs);
  for (const entry of normalized) {
    if (forbidden.check(entry.address, addressType(entry.family))) {
      throw new GatewayError("TARGET_DENIED", "Target resolves to a forbidden network range");
    }
    if (config.egressMode === "allowlist" && !allowlist.check(entry.address, addressType(entry.family))) {
      throw new GatewayError("TARGET_DENIED", "Target is outside the configured egress allowlist");
    }
  }

  const selected = normalized[0];
  return { originalHost: host, address: selected.address, family: selected.family, port };
}

export function sshConnectEndpoint(target: ResolvedTarget) {
  const address = normalizeIp(target.address);
  if (!address) throw new GatewayError("TARGET_DENIED", "Resolved target address is invalid");
  return { host: address, port: target.port, family: target.family };
}

export function connectResolvedTarget(target: ResolvedTarget, timeoutMs: number) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = new Socket();
    const endpoint = sshConnectEndpoint(target);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new GatewayError("SSH_TIMEOUT", "Target TCP connection timed out", true));
    }, timeoutMs);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("error", onError);
    };
    const onError = () => {
      cleanup();
      reject(new GatewayError("SSH_CONNECTION_FAILED", "Target TCP connection failed", true));
    };
    socket.once("error", onError);
    socket.connect(endpoint, () => {
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}