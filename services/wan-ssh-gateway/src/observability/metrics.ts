const AUTH_RESULTS = new Set(["success", "failure"]);
const AUTH_REASONS = new Set(["ok", "invalid", "timeout", "expired", "mismatch", "other"]);
const SESSION_RESULTS = new Set(["success", "failure"]);
const ERROR_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "ORIGIN_DENIED",
  "PROTOCOL_UNSUPPORTED",
  "MESSAGE_INVALID",
  "SESSION_NOT_FOUND",
  "SESSION_LIMIT",
  "RATE_LIMIT",
  "TARGET_DENIED",
  "SSH_TIMEOUT",
  "SSH_AUTH_FAILED",
  "SSH_HOST_KEY_REJECTED",
  "SSH_CONNECTION_FAILED",
  "BACKPRESSURE_LIMIT",
  "IDLE_TIMEOUT",
  "INTERNAL"
]);
const HOSTKEY_KINDS = new Set(["unknown", "changed"]);
const HOSTKEY_RESULTS = new Set(["accept", "reject", "timeout"]);
const BACKPRESSURE_ACTIONS = new Set(["pause", "resume", "close"]);
const TARGET_REASONS = new Set(["forbidden", "allowlist", "port", "unresolved", "other"]);

export type MetricsSnapshot = {
  ready: boolean;
  sessionsActive: number;
  sessionsLimit: number;
  wsConnections: number;
};

function bounded(value: string, allowed: Set<string>, fallback = "other") {
  return allowed.has(value) ? value : fallback;
}

function inc(store: Map<string, number>, key: string) {
  store.set(key, (store.get(key) ?? 0) + 1);
}

function metric(name: string, help: string, type: "gauge" | "counter" | "summary", lines: string[]) {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines, ""].join("\n");
}

export class GatewayMetrics {
  snapshot: () => MetricsSnapshot = () => ({ ready: false, sessionsActive: 0, sessionsLimit: 0, wsConnections: 0 });
  private readonly auth = new Map<string, number>();
  private readonly sessionsOpen = new Map<string, number>();
  private readonly hostKeys = new Map<string, number>();
  private readonly backpressure = new Map<string, number>();
  private readonly targetDenied = new Map<string, number>();
  private sessionDurationCount = 0;
  private sessionDurationSum = 0;
  private connectDurationCount = 0;
  private connectDurationSum = 0;
  private bytesIn = 0;
  private bytesOut = 0;

  recordAuth(result: string, reason: string) {
    inc(this.auth, `${bounded(result, AUTH_RESULTS)}|${bounded(reason, AUTH_REASONS)}`);
  }

  recordSessionOpen(result: string, errorCode?: string) {
    inc(this.sessionsOpen, `${bounded(result, SESSION_RESULTS)}|${errorCode ? bounded(errorCode, ERROR_CODES) : "none"}`);
  }

  recordSessionDuration(durationMs: number) {
    this.sessionDurationCount += 1;
    this.sessionDurationSum += Math.max(0, durationMs) / 1_000;
  }

  recordConnectDuration(durationMs: number) {
    this.connectDurationCount += 1;
    this.connectDurationSum += Math.max(0, durationMs) / 1_000;
  }

  recordBytes(direction: "in" | "out", bytes: number) {
    if (bytes <= 0) return;
    if (direction === "in") this.bytesIn += bytes;
    else this.bytesOut += bytes;
  }

  recordHostKey(kind: string, result: string) {
    inc(this.hostKeys, `${bounded(kind, HOSTKEY_KINDS)}|${bounded(result, HOSTKEY_RESULTS)}`);
  }

  recordBackpressure(action: string) {
    inc(this.backpressure, bounded(action, BACKPRESSURE_ACTIONS));
  }

  recordTargetDenied(reason: string) {
    inc(this.targetDenied, bounded(reason, TARGET_REASONS));
  }

  render() {
    const snapshot = this.snapshot();
    const authLines = [...this.auth.entries()].map(([key, value]) => {
      const [result, reason] = key.split("|");
      return `wan_ssh_ws_auth_total{result="${result}",reason="${reason}"} ${value}`;
    });
    const sessionLines = [...this.sessionsOpen.entries()].map(([key, value]) => {
      const [result, errorCode] = key.split("|");
      return `wan_ssh_sessions_open_total{result="${result}",error_code="${errorCode}"} ${value}`;
    });
    const hostKeyLines = [...this.hostKeys.entries()].map(([key, value]) => {
      const [kind, result] = key.split("|");
      return `wan_ssh_hostkey_prompts_total{kind="${kind}",result="${result}"} ${value}`;
    });
    const backpressureLines = [...this.backpressure.entries()].map(([key, value]) => `wan_ssh_backpressure_total{action="${key}"} ${value}`);
    const deniedLines = [...this.targetDenied.entries()].map(([key, value]) => `wan_ssh_target_denied_total{reason="${key}"} ${value}`);
    return [
      metric("wan_ssh_process_ready", "Gateway readiness gauge.", "gauge", [`wan_ssh_process_ready ${snapshot.ready ? 1 : 0}`]),
      metric("wan_ssh_ws_connections", "Open WebSocket connections.", "gauge", [`wan_ssh_ws_connections ${snapshot.wsConnections}`]),
      metric("wan_ssh_sessions_active", "Active SSH sessions.", "gauge", [`wan_ssh_sessions_active ${snapshot.sessionsActive}`]),
      metric("wan_ssh_sessions_limit", "Configured global SSH session limit.", "gauge", [`wan_ssh_sessions_limit ${snapshot.sessionsLimit}`]),
      metric("wan_ssh_ws_auth_total", "WebSocket authentication attempts.", "counter", authLines.length ? authLines : ['wan_ssh_ws_auth_total{result="success",reason="ok"} 0']),
      metric("wan_ssh_sessions_open_total", "SSH session open attempts.", "counter", sessionLines.length ? sessionLines : ['wan_ssh_sessions_open_total{result="success",error_code="none"} 0']),
      metric("wan_ssh_session_duration_seconds", "Finished SSH session duration.", "summary", [
        `wan_ssh_session_duration_seconds_count ${this.sessionDurationCount}`,
        `wan_ssh_session_duration_seconds_sum ${this.sessionDurationSum}`
      ]),
      metric("wan_ssh_connect_duration_seconds", "SSH connect duration.", "summary", [
        `wan_ssh_connect_duration_seconds_count ${this.connectDurationCount}`,
        `wan_ssh_connect_duration_seconds_sum ${this.connectDurationSum}`
      ]),
      metric("wan_ssh_bytes_total", "Terminal bytes transferred.", "counter", [
        `wan_ssh_bytes_total{direction="in"} ${this.bytesIn}`,
        `wan_ssh_bytes_total{direction="out"} ${this.bytesOut}`
      ]),
      metric("wan_ssh_hostkey_prompts_total", "Host-key prompt outcomes.", "counter", hostKeyLines.length ? hostKeyLines : ['wan_ssh_hostkey_prompts_total{kind="unknown",result="accept"} 0']),
      metric("wan_ssh_backpressure_total", "Terminal backpressure actions.", "counter", backpressureLines.length ? backpressureLines : ['wan_ssh_backpressure_total{action="pause"} 0']),
      metric("wan_ssh_target_denied_total", "Denied SSH targets.", "counter", deniedLines.length ? deniedLines : ['wan_ssh_target_denied_total{reason="forbidden"} 0'])
    ].join("");
  }
}

export function targetDeniedReason(message: string) {
  if (/port/i.test(message)) return "port";
  if (/allowlist/i.test(message)) return "allowlist";
  if (/forbidden/i.test(message)) return "forbidden";
  if (/resolved|hostname/i.test(message)) return "unresolved";
  return "other";
}

export function authFailureReason(code: string) {
  if (code === "AUTH_REQUIRED") return "timeout";
  if (code === "AUTH_INVALID") return "invalid";
  return "other";
}
