/** Shared contract for Super App modules (cliproxy / net). */

import type { BrowserWindow } from "electron";

export type ModuleId = "cliproxy" | "net" | "ssh";

export interface ModuleHandle {
  id: ModuleId;
  show: () => void;
  hide: () => void;
  shutdown: () => Promise<void>;
  isRunning: () => boolean;
  /** Optional status for hub pills. */
  getStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Replace-mode: load this module's UI into an existing shell window
   * (does not create a second BrowserWindow).
   */
  presentIn?: (win: BrowserWindow) => void | Promise<void>;
}
