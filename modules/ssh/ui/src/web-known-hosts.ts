export type WebKnownHost = {
  key: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  firstSeenAt: number;
  updatedAt: number;
};

const DATABASE_NAME = "wan-ssh-web";
const STORE_NAME = "known-hosts";

function keyFor(host: string, port: number) {
  return `${host.trim().toLowerCase()}:${port}`;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Known-host database is unavailable"));
  });
}

export async function getKnownHost(host: string, port: number) {
  const database = await openDatabase();
  try {
    return await new Promise<WebKnownHost | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(keyFor(host, port));
      request.onsuccess = () => resolve(request.result as WebKnownHost | undefined);
      request.onerror = () => reject(request.error ?? new Error("Known-host lookup failed"));
    });
  } finally {
    database.close();
  }
}

export async function saveKnownHost(input: Omit<WebKnownHost, "key" | "firstSeenAt" | "updatedAt">) {
  const existing = await getKnownHost(input.host, input.port);
  const now = Date.now();
  const value: WebKnownHost = {
    ...input,
    key: keyFor(input.host, input.port),
    firstSeenAt: existing?.firstSeenAt ?? now,
    updatedAt: now
  };
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Known-host save failed"));
    });
  } finally {
    database.close();
  }
}

export async function listKnownHosts(): Promise<WebKnownHost[]> {
  const database = await openDatabase();
  try {
    return await new Promise<WebKnownHost[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as WebKnownHost[]).sort((left, right) => left.host.localeCompare(right.host) || left.port - right.port));
      request.onerror = () => reject(request.error ?? new Error("Known-host listing failed"));
    });
  } finally {
    database.close();
  }
}

export async function removeKnownHost(key: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Known-host removal failed"));
    });
  } finally {
    database.close();
  }
}