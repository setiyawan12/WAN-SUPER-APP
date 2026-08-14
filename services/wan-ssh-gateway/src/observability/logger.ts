import { createHash } from "node:crypto";
import type { LogLevel } from "../config.js";

const levels: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const allowedFields = new Set([
  "request_id",
  "connection_id",
  "session_id",
  "principal_id_hash",
  "client_address_hash",
  "target_host_hash",
  "target_class",
  "target_port",
  "duration_ms",
  "error_code",
  "reason"
]);

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function hashLogValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function createLogger(minimumLevel: LogLevel): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (levels[level] < levels[minimumLevel]) return;
    const safeFields = Object.fromEntries(Object.entries(fields).filter(([key, entry]) => allowedFields.has(key) && entry !== undefined));
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeFields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}