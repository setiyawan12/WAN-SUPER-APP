export type ModuleId = "cliproxy" | "net" | "ssh" | "mindmap";

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

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  message: string | null;
  isPackaged: boolean;
  lastCheckedAt: number | null;
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
    ssh: Record<string, unknown>;
    mindmap: Record<string, unknown>;
  }>;
  getVersion: () => Promise<string>;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateStatus>;
  downloadUpdate: () => Promise<UpdateStatus>;
  installUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
}

declare global {
  interface Window {
    superApp: SuperAppApi;
  }
}

export {};
