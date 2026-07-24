export type ModuleId = "cliproxy" | "net";

export interface SuperAppSettings {
  lastModule: ModuleId | null;
  reopenLastModule: boolean;
  autoLaunch: boolean;
  startHidden: boolean;
  keepAliveWhenLeaving: boolean;
  /** true = own window per module; false = replace hub page with module UI */
  openInNewWindow: boolean;
  theme: "aurora-dark";
  windowBoundsHub?: { width: number; height: number; x?: number; y?: number };
}

export interface SuperAppApi {
  getSettings: () => Promise<SuperAppSettings>;
  setSetting: <K extends keyof SuperAppSettings>(
    key: K,
    value: SuperAppSettings[K]
  ) => Promise<SuperAppSettings>;
  setSettings: (patch: Partial<SuperAppSettings>) => Promise<SuperAppSettings>;
  openModule: (id: ModuleId) => Promise<{ ok: boolean; error?: string }>;
  showHub: () => Promise<{ ok: boolean }>;
  moduleState: () => Promise<{
    cliproxy: Record<string, unknown>;
    net: Record<string, unknown>;
  }>;
  getVersion: () => Promise<string>;
}

declare global {
  interface Window {
    superApp: SuperAppApi;
  }
}

export {};
