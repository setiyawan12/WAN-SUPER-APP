import { onValue, ref, runTransaction, type Database } from "firebase/database";
import type { CloudVaultMeta } from "./web-vault";

type CloudEntity = {
  id: string;
  type: string;
  ownerUid: string;
  vaultId: "personal";
  updatedAt: number;
  version: number;
  deletedAt: number | null;
  [key: string]: unknown;
};

function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class WebCloudStore {
  private readonly items = new Map<string, CloudEntity>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private initialized = false;
  private initialization?: Promise<void>;
  private vaultMeta: CloudVaultMeta | null = null;

  constructor(private readonly database: Database, readonly uid: string) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = new Promise<void>((resolve, reject) => {
      let itemsReady = false;
      let metaReady = false;
      let settled = false;
      const timeout = window.setTimeout(() => fail(new Error("Cloud catalog connection timed out. Check Firebase RTDB access and Content Security Policy.")), 15_000);
      const finish = () => {
        if (itemsReady && metaReady && !settled) {
          settled = true;
          window.clearTimeout(timeout);
          this.initialized = true;
          resolve();
        }
      };
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(error);
        }
      };
      this.unsubscribers.push(onValue(ref(this.database, this.itemsPath()), (snapshot) => {
        this.items.clear();
        const value = snapshot.val();
        if (value && typeof value === "object") {
          for (const entity of Object.values(value) as CloudEntity[]) {
            if (entity && entity.id && entity.vaultId === "personal") this.items.set(entity.id, { ...entity, deletedAt: entity.deletedAt ?? null });
          }
        }
        itemsReady = true;
        this.emit();
        finish();
      }, (error) => fail(error)));
      this.unsubscribers.push(onValue(ref(this.database, this.metaPath()), (snapshot) => {
        this.vaultMeta = snapshot.exists() ? snapshot.val() as CloudVaultMeta : null;
        metaReady = true;
        this.emit();
        finish();
      }, (error) => fail(error)));
    });
    return this.initialization;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.listeners.clear();
    this.items.clear();
    this.initialized = false;
    this.initialization = undefined;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ready(): Promise<void> {
    await this.initialize();
  }

  meta(): CloudVaultMeta | null {
    return this.vaultMeta ? sanitize(this.vaultMeta) : null;
  }

  async saveMeta(meta: CloudVaultMeta): Promise<void> {
    await this.ready();
    const previousVersion = this.vaultMeta?.version ?? 0;
    const result = await runTransaction(ref(this.database, this.metaPath()), (current) => {
      const remoteVersion = Number(current?.version ?? 0);
      if (remoteVersion > previousVersion) return;
      return sanitize(meta);
    }, { applyLocally: false });
    if (!result.committed) throw new Error("Cloud vault changed on another device. Reload and unlock it again.");
    this.vaultMeta = sanitize(meta);
    this.emit();
  }

  list<T extends CloudEntity = CloudEntity>(type: string): T[] {
    this.assertInitialized();
    return [...this.items.values()]
      .filter((entity) => entity.type === type && entity.deletedAt === null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((entity) => sanitize(entity as T));
  }

  get<T extends CloudEntity = CloudEntity>(id: string): T | null {
    this.assertInitialized();
    const entity = this.items.get(id);
    return entity && entity.deletedAt === null ? sanitize(entity as T) : null;
  }

  async upsert<T extends CloudEntity>(entity: T, previousVersion = this.items.get(entity.id)?.version ?? 0): Promise<void> {
    await this.ready();
    const value = sanitize(entity);
    const result = await runTransaction(ref(this.database, `${this.itemsPath()}/${entity.id}`), (current) => {
      const remoteVersion = Number(current?.version ?? 0);
      if (remoteVersion > previousVersion) return;
      return value;
    }, { applyLocally: false });
    if (!result.committed) throw new Error("This cloud item changed on another device. Reload before saving again.");
    this.items.set(entity.id, value);
    this.emit();
  }

  async remove(id: string): Promise<void> {
    await this.ready();
    const current = this.items.get(id);
    if (!current || current.deletedAt !== null) return;
    const now = Date.now();
    await this.upsert({ ...current, updatedAt: now, deletedAt: now, version: current.version + 1 }, current.version);
  }

  private itemsPath(): string {
    return `users/${this.uid}/vaults/personal/items`;
  }

  private metaPath(): string {
    return `users/${this.uid}/vaultMeta/personal`;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Cloud catalog is still loading");
  }
}