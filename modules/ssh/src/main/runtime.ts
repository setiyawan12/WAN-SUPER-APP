import type { AppContext } from "./context.js";

/** State runtime bersama antar-modul (ctx global + flag boot/ipc). */
export const runtime: {
  ctx: AppContext | null;
  ipcRegistered: boolean;
} = {
  ctx: null,
  ipcRegistered: false
};

export function requireCtx(): AppContext {
  if (!runtime.ctx) throw new Error("SSH runtime belum siap");
  return runtime.ctx;
}
