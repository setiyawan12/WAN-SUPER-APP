import os from "node:os";
import path from "node:path";
import net from "node:net";

// Single source of truth for ports/paths, shared across the main process.
// The verbatim backend (src/main/backend) reads these from process.env
// (PORT / CLIPROXY_HOME / CLIPROXY_PORT), which index.ts sets before booting
// it -- see prepareBackendEnv() + ensureFreePort() below.
//
// Read LAZILY (functions, not constants): ensureFreePort() may bump PORT at
// startup if the default is taken, and every consumer must see the final port.

const DEFAULT_PORT = 4317;

export function backendPort(): number {
  return Number(process.env.PORT || DEFAULT_PORT);
}

export function backendUrl(): string {
  return `http://127.0.0.1:${backendPort()}`;
}

// Super App home (HANDBOOK-WAN-SUPER-APP): ~/.wan-super-app/cliproxyapi
// Standalone wan-cliproxyapi used ~/.wan-cliproxyapi/cliproxyapi — isolated here.
export const CLIPROXY_HOME = path.join(os.homedir(), ".wan-super-app", "cliproxyapi");

export const CLIPROXY_PORT = Number(process.env.CLIPROXY_PORT || 8317);

/**
 * Populate the environment the verbatim backend/settings.js reads at import
 * time. Must run BEFORE `import("./backend/index.js")`. This is the ONLY thing
 * that changes the backend's home from the extension's ~/.renn-copilot to the
 * Super App's ~/.wan-super-app/cliproxyapi -- the backend files themselves stay
 * byte-for-byte identical to the extension repo.
 */
export function prepareBackendEnv(autoStartServer: boolean): void {
  process.env.PORT ||= String(DEFAULT_PORT);
  // Always pin Super App storage to ~/.wan-super-app/cliproxyapi unless the
  // user explicitly exports CLIPROXY_HOME under that tree. Leftover
  // CLIPROXY_HOME from VS Code extension or standalone desktop must not steal
  // OAuth writes.
  const existing = process.env.CLIPROXY_HOME;
  if (
    !existing ||
    existing.includes(".renn-copilot") ||
    existing.includes(".wan-cliproxyapi")
  ) {
    process.env.CLIPROXY_HOME = CLIPROXY_HOME;
  }
  process.env.CLIPROXY_PORT ||= String(CLIPROXY_PORT);
  // Mirrors the extension's RENN_AUTO_START_SERVER=1 -> auto-click "Start"
  // on the Overview page, but only if the binary is already installed.
  if (autoStartServer) process.env.RENN_AUTO_START_SERVER = "1";
  console.log(`[wan] CLIPROXY_HOME=${process.env.CLIPROXY_HOME}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Ensures the backend port is actually bindable before we import the verbatim
 * backend (which calls app.listen() with no error handler -- an EADDRINUSE
 * there is an uncaught exception that crashes the app). The default 4317 is
 * shared with the Renn-Copilot VS Code extension's backend and with any
 * lingering tray instance of this app, so if it's taken we transparently walk
 * up to the next free port. All consumers read backendPort()/backendUrl()
 * lazily, so they follow whatever we land on.
 */
export async function ensureFreePort(): Promise<number> {
  let port = backendPort();
  for (let i = 0; i < 20; i++) {
    if (await isPortFree(port)) break;
    port++;
  }
  process.env.PORT = String(port);
  return port;
}
