import { useEffect, useRef, useState } from "react";
import { ArrowDown, Copy, Download, Search } from "lucide-react";

function logTone(line: string) {
  if (/\b(error|fatal|failed|failure)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  if (/\b(success|ready|started|running|connected|ok)\b/i.test(line)) return "success";
  return "";
}

/** Ported from dashboard/components/ui/log-viewer.tsx -- auto-scroll only while pinned to bottom. */
export function LogViewer({ lines, downloadFilename = "log.txt" }: { lines: string[]; downloadFilename?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [query, setQuery] = useState("");

  const filtered = query.trim() ? lines.filter((l) => l.toLowerCase().includes(query.trim().toLowerCase())) : lines;

  useEffect(() => {
    if (pinned) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [filtered.length, pinned]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distanceFromBottom < 32);
  }

  function jumpToBottom() {
    setPinned(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(filtered.join("\n"));
    } catch {
      // Clipboard access can be denied in some webview contexts -- nothing more to do.
    }
  }

  function downloadAll() {
    const blob = new Blob([filtered.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadFilename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <label className="log-search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter lines..." />
          {query && (
            <span className="log-match-count">
              {filtered.length}/{lines.length}
            </span>
          )}
        </label>
        <button type="button" className="log-action" disabled={!filtered.length} title="Copy visible lines" onClick={copyAll}>
          <Copy size={15} />
          <span>Copy</span>
        </button>
        <button type="button" className="log-action" disabled={!filtered.length} title="Download visible lines" onClick={downloadAll}>
          <Download size={15} />
          <span>Download</span>
        </button>
      </div>

      <div className="log-box" ref={scrollRef} onScroll={handleScroll}>
        {filtered.length === 0 && <span className="log-empty">{query ? "No lines match your filter." : "Waiting for log events..."}</span>}
        {filtered.map((line, i) => (
          <div key={i} className={`log-line ${logTone(line)}`}>
            <span className="log-line-number">{String(i + 1).padStart(3, "0")}</span>
            <span className="log-line-text">{line}</span>
          </div>
        ))}
        {!pinned && lines.length > 0 && (
          <button className="jump-to-latest" onClick={jumpToBottom}>
            <ArrowDown size={14} />
            Jump to latest
          </button>
        )}
      </div>
    </div>
  );
}
