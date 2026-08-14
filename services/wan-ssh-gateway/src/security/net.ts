import { BlockList, isIP } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { GatewayConfig } from "../config.js";

export type AddressSource = {
  socket?: { remoteAddress?: string | null };
  headers: IncomingHttpHeaders;
};

export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.toLowerCase().startsWith("::ffff:") && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) ? value : undefined;
}

export function createCidrList(cidrs: string[]) {
  const blockList = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefixText] = cidr.split("/");
    const family = isIP(address);
    if (family !== 4 && family !== 6) continue;
    blockList.addSubnet(address, Number(prefixText), family === 4 ? "ipv4" : "ipv6");
  }
  return blockList;
}

export function ipMatchesCidrs(address: string, cidrs: string[]) {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return false;
  return createCidrList(cidrs).check(address, family === 4 ? "ipv4" : "ipv6");
}

function singleHeaderIp(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    if (value.length !== 1) return undefined;
    value = value[0];
  }
  if (!value || value.includes(",")) return undefined;
  return normalizeIp(value);
}

export function resolveClientAddress(config: GatewayConfig, request: AddressSource): string {
  const peer = normalizeIp(request.socket?.remoteAddress) ?? "unknown";
  if (peer === "unknown" || !ipMatchesCidrs(peer, config.trustedProxyCidrs)) return peer;
  return singleHeaderIp(request.headers["x-real-ip"])
    ?? singleHeaderIp(request.headers["x-forwarded-for"])
    ?? peer;
}
