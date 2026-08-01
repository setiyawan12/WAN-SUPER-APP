import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Radio, Server, SquareTerminal } from "lucide-react";
import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { LogViewer } from "../components/LogViewer";
import { PageHeader } from "../components/shared";

const POLL_MS = 3000;
const MAX_LINES = 3000; // client-side cap so a long-running session doesn't grow unbounded
const INITIAL_LOOKBACK_SECONDS = 300; // first fetch shows the last 5 minutes, not CLIProxyAPI's entire on-disk history

/**
 * CLIProxyAPI's GET /logs has no way to limit line count -- an `after`
 * timestamp is the only filter. Calling it with no `after` (as this used to
 * do every 3s) re-fetches the *entire* on-disk log every poll, which got
 * dramatically slower over a long session once logging-to-file was enabled
 * (the log only grows, never shrinks, until CLIProxyAPI restarts). This
 * seeds `after` with a recent timestamp on mount, then advances it to each
 * response's `latest-timestamp` so subsequent polls only fetch new lines.
 */
function useProxyLogTail(enabled: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const cursorRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    cursorRef.current = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_SECONDS;
    setLines([]);
  }, [enabled]);

  usePolling(
    async () => {
      const result = await api.getProxyLogs(cursorRef.current);
      if (result["latest-timestamp"]) cursorRef.current = result["latest-timestamp"];
      if (result.lines?.length) {
        setLines((prev) => {
          const next = [...prev, ...result.lines];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
      return result;
    },
    POLL_MS,
    enabled
  );

  return lines;
}

export function Logs() {
  const [source, setSource] = useState<"backend" | "proxy">("proxy");
  const { data: own } = usePolling(api.getOwnLogs, POLL_MS, source === "backend");
  const proxyLines = useProxyLogTail(source === "proxy");

  const lines = source === "backend" ? own?.lines ?? [] : proxyLines;
  const errorCount = lines.filter((line) => /\b(error|fatal|failed|failure)\b/i.test(line)).length;
  const warningCount = lines.filter((line) => /\b(warn|warning)\b/i.test(line)).length;
  const sourceTitle = source === "proxy" ? "CLIProxyAPI request log" : "Backend process log";
  const sourceDescription = source === "proxy"
    ? `Last ${Math.round(INITIAL_LOOKBACK_SECONDS / 60)} minutes on load, then incremental live tail.`
    : "Application lifecycle, startup, and backend process output.";

  return (
    <div className="page logs-page">
      <PageHeader
        eyebrow="Diagnostics"
        title="Logs"
        subtitle="Inspect live proxy traffic and backend process output."
        actions={<span className="logs-live-pill"><Radio size={14} />Live tail · {POLL_MS / 1000}s</span>}
      />

      <div className="logs-wrap">
        <section className="logs-status-strip">
          <div className="logs-status-main">
            <span className="logs-status-icon">{source === "proxy" ? <Activity size={20} /> : <Server size={20} />}</span>
            <div>
              <span className="logs-status-kicker">Active stream</span>
              <strong>{sourceTitle}</strong>
              <p>{sourceDescription}</p>
            </div>
          </div>

          <div className="logs-status-metrics">
            <span><strong>{lines.length.toLocaleString()}</strong>lines buffered</span>
            <span className={warningCount ? "warn" : ""}><strong>{warningCount.toLocaleString()}</strong>warnings</span>
            <span className={errorCount ? "error" : ""}><strong>{errorCount.toLocaleString()}</strong>errors</span>
          </div>
        </section>

        <div className="logs-source-row">
          <div className="logs-source-switch" role="tablist" aria-label="Log source">
            <button type="button" role="tab" aria-selected={source === "proxy"} className={source === "proxy" ? "active" : ""} onClick={() => setSource("proxy")}>
              <Activity size={15} />
              CLIProxyAPI
              <span>Requests</span>
            </button>
            <button type="button" role="tab" aria-selected={source === "backend"} className={source === "backend" ? "active" : ""} onClick={() => setSource("backend")}>
              <Server size={15} />
              Backend
              <span>Process</span>
            </button>
          </div>
          <span className="logs-buffer-note"><AlertTriangle size={14} />Client buffer capped at {MAX_LINES.toLocaleString()} lines</span>
        </div>

        <section className="logs-console">
          <div className="logs-console-head">
            <div>
              <span className="logs-console-icon"><SquareTerminal size={17} /></span>
              <div>
                <strong>{sourceTitle}</strong>
                <span>Newest events appear at the bottom</span>
              </div>
            </div>
            <span className="logs-stream-state"><i />Streaming</span>
          </div>
          <LogViewer lines={lines} downloadFilename={source === "proxy" ? "cliproxyapi-log.txt" : "backend-log.txt"} />
        </section>
      </div>
    </div>
  );
}
