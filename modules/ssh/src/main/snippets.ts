import { VAULT } from "./constants.js";
import { itemRepo } from "./repo.js";

export class SnippetService {
  ownerUid: () => string;

  constructor(ownerUid: () => string) {
    this.ownerUid = ownerUid;
  }

  list() {
    return itemRepo.listByTypeAll("snippet").map((snippet: any) => ({
      id: snippet.id,
      vaultId: snippet.vaultId,
      label: snippet.label,
      command: snippet.command,
      description: snippet.description ?? "",
      tags: snippet.tags ?? [],
      updatedAt: snippet.updatedAt
    }));
  }

  get(id: string) {
    const snippet = itemRepo.get(id);
    return snippet?.type === "snippet" ? snippet : null;
  }

  save(input: any) {
    const now = Date.now();
    const existing = input.id ? this.get(input.id) : null;
    const id = existing?.id ?? itemRepo.newId();
    itemRepo.upsert({
      id,
      type: "snippet",
      ownerUid: this.ownerUid(),
      vaultId: existing?.vaultId ?? input.vaultId ?? VAULT.defaultVaultId,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
      deletedAt: null,
      label: input.label,
      command: input.command,
      description: input.description ?? existing?.description ?? "",
      tags: input.tags ?? existing?.tags ?? []
    });
    return id;
  }

  remove(id: string) {
    const snippet = this.get(id);
    if (snippet) itemRepo.remove(id);
  }
}