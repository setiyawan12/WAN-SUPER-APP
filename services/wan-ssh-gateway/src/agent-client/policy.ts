import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolvedEgress = { address: string; family: 4 | 6; port: number };

export type EgressPolicyOptions = {
  allowCidrs?: string[];
  allowLoopback?: boolean;
};

function forbiddenList(allowLoopback: boolean) {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("224.0.0.0", 4, "ipv4");
  list.addSubnet("::", 128, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  if (!allowLoopback) {
    list.addSubnet("127.0.0.0", 8, "ipv4");
    list.addSubnet("::1", 128, "ipv6");
  }
  return list;
}

function cidrList(cidrs: string[]) {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split("/");
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || !/^\d{1,3}$/.test(prefix ?? "")) throw new Error(`Allowed CIDR is invalid: ${cidr}`);
    list.addSubnet(address, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

function addressFamily(address: string) {
  const value = isIP(address);
  if (value !== 4 && value !== 6) throw new Error("Resolved address is invalid");
  return value as 4 | 6;
}

export interface EgressPolicy {
  resolve(host: string, port: number): Promise<ResolvedEgress>;
}

/**
 * Gateway sengaja melewati `resolveTarget` untuk sesi client-agent, jadi
 * seluruh penyaringan tujuan terjadi di sini. Tanpa guard ini siapa pun yang
 * memegang akun bisa menyuruh laptop ini menembak loopback atau endpoint
 * metadata miliknya sendiri.
 */
export function createEgressPolicy(options: EgressPolicyOptions = {}): EgressPolicy {
  const forbidden = forbiddenList(Boolean(options.allowLoopback));
  const allowed = options.allowCidrs?.length ? cidrList(options.allowCidrs) : undefined;
  return {
    async resolve(host, port) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Target port is invalid");
      const literal = isIP(host);
      const candidates = literal
        ? [{ address: host, family: literal }]
        : await lookup(host, { all: true, verbatim: true }).catch(() => {
          throw new Error(`Target hostname could not be resolved: ${host}`);
        });
      if (!candidates.length) throw new Error(`Target hostname returned no addresses: ${host}`);
      for (const candidate of candidates) {
        const type = addressFamily(candidate.address) === 4 ? "ipv4" : "ipv6";
        if (forbidden.check(candidate.address, type)) throw new Error(`Target resolves to a forbidden network range: ${host}`);
        if (allowed && !allowed.check(candidate.address, type)) throw new Error(`Target is outside the agent allowlist: ${host}`);
      }
      const selected = candidates[0];
      return { address: selected.address, family: addressFamily(selected.address), port };
    }
  };
}
