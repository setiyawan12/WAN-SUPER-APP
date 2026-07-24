import { EventEmitter } from "node:events";

// Singleton bus for "a request just passed through the proxy" signals. Kept as
// its own tiny, Electron-agnostic module on purpose: chat-proxy.js emits on it
// with a plain sibling import, and the Electron main process (index.ts) is the
// ONLY thing that bridges these events to the renderer via broadcast(). That
// keeps the verbatim backend from ever importing Electron/main code (no import
// cycle, still runnable outside Electron), while the live "neuron" activity
// feed in the dashboard gets millisecond-fresh Claude/in-app hits.
//
// Event: "hit" with payload
//   { phase: "start" | "end", reqId, model, provider?, ok?, latency_ms?, ts }
export const activityBus = new EventEmitter();

// main + tests may both subscribe; this is a fire-and-forget notification bus,
// not a backpressure path, so silence the >10-listener leak warning.
activityBus.setMaxListeners(0);
