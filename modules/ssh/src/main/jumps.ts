import { SSH } from "./constants.js";
import { SshError } from "./errors.js";

export function resolveJumpChain(host: any, get: (id: string) => any, maxHops = SSH.maxJumpHosts) {
  const chain: any[] = [];
  const seen = new Set<string>();
  if (host.id) seen.add(host.id);
  let jumpHostId = host.jumpHostId;

  while (jumpHostId) {
    if (seen.has(jumpHostId)) throw new SshError("UNKNOWN", "Rantai jump host membentuk siklus");
    if (chain.length >= maxHops) throw new SshError("UNKNOWN", `Maksimal ${maxHops} jump host didukung`);
    seen.add(jumpHostId);
    const jumpHost = get(jumpHostId);
    if (!jumpHost || jumpHost.type !== "host") throw new SshError("UNKNOWN", "Jump host tidak ditemukan");
    chain.push(jumpHost);
    jumpHostId = jumpHost.jumpHostId;
  }

  return chain.reverse();
}