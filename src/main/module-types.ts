/** Shared contract for Super App modules (cliproxy / net). */

export type ModuleId = "cliproxy" | "net";

export interface ModuleHandle {
  id: ModuleId;
  show: () => void;
  hide: () => void;
  shutdown: () => Promise<void>;
  isRunning: () => boolean;
  /** Optional status for hub pills. */
  getStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}
