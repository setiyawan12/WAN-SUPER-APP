import { EventEmitter } from "node:events";

// Pure Node event bus. Electron notification wiring stays in main/index.ts and
// super-boot.ts, preserving the backend's standalone/testable boundary.
export const quotaBudgetBus = new EventEmitter();
quotaBudgetBus.setMaxListeners(20);