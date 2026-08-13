import { LineType, parse, type Section } from "ssh-config";
import { SSH } from "./constants.js";
import { resolveJumpChain } from "./jumps.js";
import { itemRepo } from "./repo.js";
import type { HostService } from "./hosts.js";

export type OpenSshHostCandidate = {
  alias: string;
  label: string;
  address: string;
  port: number | null;
  username: string | null;
  agentForwarding: boolean;
  proxyJumps: string[];
  identityFiles: string[];
};

function directiveValues(value: Section["value"]) {
  if (Array.isArray(value)) return value.map((part) => part.val).filter(Boolean);
  return value.trim().split(/\s+/).filter(Boolean);
}

function stringValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parseJump(value: string) {
  const trimmed = value.trim();
  const withoutUser = trimmed.includes("@") ? trimmed.slice(trimmed.lastIndexOf("@") + 1) : trimmed;
  if (withoutUser.startsWith("[")) {
    const closing = withoutUser.indexOf("]");
    return closing > 0 ? withoutUser.slice(1, closing) : withoutUser;
  }
  const colon = withoutUser.lastIndexOf(":");
  return colon > 0 && /^\d+$/.test(withoutUser.slice(colon + 1)) ? withoutUser.slice(0, colon) : withoutUser;
}

function isConcreteAlias(value: string) {
  return Boolean(value) && !value.startsWith("!") && !/[*?]/.test(value);
}

export function parseOpenSshConfig(text: string | Buffer) {
  const config = parse(text);
  const candidates = new Map<string, OpenSshHostCandidate>();
  const warnings: string[] = [];
  const hasInclude = config.some((line: any) => line.type === LineType.DIRECTIVE && /^include$/i.test(line.param));
  if (hasInclude) warnings.push("Include directives are not expanded; import included files separately.");

  const sections = config.filter((line: any): line is Section =>
    line.type === LineType.DIRECTIVE && /^host$/i.test(line.param) && Array.isArray(line.config)
  );
  for (const section of sections) {
    for (const alias of directiveValues(section.value)) {
      if (!isConcreteAlias(alias)) continue;
      const effective = config.compute(alias, { ignoreCase: true, matchExec: false });
      const proxyJump = stringValue(effective.proxyjump);
      const identityValue = effective.identityfile;
      const identityFiles = Array.isArray(identityValue) ? identityValue : identityValue ? [identityValue] : [];
      const rawPort = Number(stringValue(effective.port));
      candidates.set(alias.toLowerCase(), {
        alias,
        label: alias,
        address: stringValue(effective.hostname) || alias,
        port: Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : null,
        username: stringValue(effective.user) || null,
        agentForwarding: /^(?:yes|true)$/i.test(stringValue(effective.forwardagent)),
        proxyJumps: !proxyJump || /^none$/i.test(proxyJump)
          ? []
          : proxyJump.split(",").map((part) => parseJump(part)).filter(isConcreteAlias),
        identityFiles
      });
    }
  }

  for (const candidate of [...candidates.values()]) {
    for (const jumpAlias of candidate.proxyJumps) {
      const key = jumpAlias.toLowerCase();
      if (candidates.has(key)) continue;
      candidates.set(key, {
        alias: jumpAlias,
        label: jumpAlias,
        address: jumpAlias,
        port: null,
        username: null,
        agentForwarding: false,
        proxyJumps: [],
        identityFiles: []
      });
      warnings.push(`ProxyJump ${jumpAlias} had no concrete Host block; imported as a direct host.`);
    }
  }

  return { candidates: [...candidates.values()], warnings };
}

export function resolveOpenSshParents(candidates: OpenSshHostCandidate[]) {
  const aliases = new Set(candidates.map((candidate) => candidate.alias.toLowerCase()));
  const parents = new Map<string, string | null>();
  const assign = (child: string, parent: string | null, source: string) => {
    const childKey = child.toLowerCase();
    const parentKey = parent?.toLowerCase() ?? null;
    if (!aliases.has(childKey)) throw new Error(`Host ${child} tidak ditemukan saat membangun ProxyJump`);
    if (parentKey && !aliases.has(parentKey)) throw new Error(`Jump host ${parent} tidak ditemukan`);
    if (childKey === parentKey) throw new Error(`ProxyJump ${source} membentuk siklus pada ${child}`);
    if (parents.has(childKey) && parents.get(childKey) !== parentKey) {
      throw new Error(`ProxyJump ${child} memiliki parent yang bertentangan`);
    }
    parents.set(childKey, parentKey);
  };

  for (const candidate of candidates) {
    if (candidate.proxyJumps.length > SSH.maxJumpHosts) {
      throw new Error(`ProxyJump ${candidate.alias} melebihi ${SSH.maxJumpHosts} hop`);
    }
    let previous: string | null = null;
    for (const jumpAlias of candidate.proxyJumps) {
      assign(jumpAlias, previous, candidate.alias);
      previous = jumpAlias;
    }
    if (candidate.proxyJumps.length) assign(candidate.alias, previous, candidate.alias);
  }
  for (const candidate of candidates) {
    const key = candidate.alias.toLowerCase();
    if (!parents.has(key)) parents.set(key, null);
  }

  for (const candidate of candidates) {
    const seen = new Set<string>();
    let cursor: string | null = candidate.alias.toLowerCase();
    let hops = 0;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`ProxyJump ${candidate.alias} membentuk siklus`);
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
      if (cursor && ++hops > SSH.maxJumpHosts) throw new Error(`ProxyJump ${candidate.alias} melebihi ${SSH.maxJumpHosts} hop`);
    }
  }
  return parents;
}

export class OpenSshImportService {
  hosts: HostService;

  constructor(hosts: HostService) {
    this.hosts = hosts;
  }

  import(text: string | Buffer) {
    const parsed = parseOpenSshConfig(text);
    const parentAliases = resolveOpenSshParents(parsed.candidates);
    const existing = itemRepo.listByTypeAll("host");
    const aliasIds = new Map<string, string>();
    let imported = 0;
    let updated = 0;

    for (const candidate of parsed.candidates) {
      const previous = existing.find((host: any) => String(host.openSshAlias ?? "").toLowerCase() === candidate.alias.toLowerCase());
      const id = this.hosts.saveHost({
        id: previous?.id,
        vaultId: previous?.vaultId ?? "local",
        label: candidate.label,
        address: candidate.address,
        port: candidate.port,
        protocol: "ssh",
        username: candidate.username ?? undefined,
        jumpHostId: null,
        agentForwarding: candidate.agentForwarding,
        autoReconnect: previous?.autoReconnect ?? true,
        reconnectLimit: previous?.reconnectLimit ?? 3,
        keepAliveInterval: previous?.keepAliveInterval ?? 0,
        openSshAlias: candidate.alias
      });
      aliasIds.set(candidate.alias.toLowerCase(), id);
      if (previous) updated += 1;
      else imported += 1;
    }

    const proposed = new Map<string, any>();
    for (const candidate of parsed.candidates) {
      const key = candidate.alias.toLowerCase();
      const hostId = aliasIds.get(key);
      const host = hostId ? itemRepo.get(hostId) : null;
      if (!host) continue;
      const parentAlias = parentAliases.get(key);
      proposed.set(host.id, { ...host, jumpHostId: parentAlias ? aliasIds.get(parentAlias) ?? null : null });
    }
    for (const host of proposed.values()) {
      resolveJumpChain(host, (id) => proposed.get(id) ?? itemRepo.get(id));
    }
    const now = Date.now();
    for (const host of proposed.values()) {
      const current = itemRepo.get(host.id);
      if (current?.jumpHostId === host.jumpHostId) continue;
      itemRepo.upsert({ ...host, updatedAt: now, version: (current?.version ?? 0) + 1 });
    }

    const identityFilesSkipped = [...new Set(parsed.candidates.flatMap((candidate) => candidate.identityFiles))];
    if (identityFilesSkipped.length) parsed.warnings.push("IdentityFile entries were not read; import private keys explicitly from SSH Keys.");
    return { imported, updated, identityFilesSkipped, warnings: parsed.warnings };
  }
}