import { useMemo, useState } from "react";
import { toast } from "./ui";

// Artifacts panel (HANDBOOK M5 / §8). Scans assistant turns for renderable
// fenced code blocks (```html / ```svg / ```mermaid) and previews them live in
// a side panel. HTML/SVG render inside a *sandboxed* iframe with an opaque
// origin and no allow-same-origin, so artifact scripts can never reach the app,
// its IPC bridge, or the file system (§10 / §12). Mermaid is shown as source
// (no diagram lib is bundled) — still useful, just not rendered.

export interface Artifact {
  id: string;
  lang: "html" | "svg" | "mermaid";
  title: string;
  code: string;
}

const FENCE = /```([a-zA-Z0-9]+)?\s*\n([\s\S]*?)```/g;

function classify(lang: string | undefined, code: string): Artifact["lang"] | null {
  const l = (lang ?? "").toLowerCase();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "mermaid") return "mermaid";
  // Unlabeled/xml block that is really an <svg> — treat as an SVG artifact.
  if ((l === "" || l === "xml") && /^\s*<svg[\s>]/i.test(code)) return "svg";
  // Unlabeled block that is a full HTML document.
  if (l === "" && /^\s*<(!doctype html|html[\s>])/i.test(code)) return "html";
  return null;
}

/** Pull every renderable artifact out of a set of assistant messages. */
export function extractArtifacts(messages: { id: string; role: string; content: string }[]): Artifact[] {
  const out: Artifact[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.content) continue;
    FENCE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let n = 0;
    while ((match = FENCE.exec(m.content))) {
      const code = match[2].trim();
      const kind = classify(match[1], code);
      if (!kind) continue;
      n += 1;
      out.push({ id: `${m.id}:${n}`, lang: kind, title: `${kind.toUpperCase()} ${n}`, code });
    }
  }
  return out;
}

function srcDoc(a: Artifact): string {
  if (a.lang === "svg") {
    return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#0b0c16}svg{max-width:100%;max-height:100%}</style>${a.code}`;
  }
  // Full HTML document passed through as-is; a bare fragment gets a minimal shell.
  if (/^\s*<(!doctype|html[\s>])/i.test(a.code)) return a.code;
  return `<!doctype html><meta charset="utf-8"><body>${a.code}</body>`;
}

export function ArtifactsPanel({ artifacts, onClose }: { artifacts: Artifact[]; onClose: () => void }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useMemo(
    () => artifacts.find((a) => a.id === activeId) ?? artifacts[artifacts.length - 1] ?? null,
    [artifacts, activeId]
  );

  function copy(code: string) {
    void window.wan.copyText(code);
    toast.success("Copied");
  }

  return (
    <aside className="chat-artifacts">
      <div className="chat-artifacts-head">
        <span className="chat-artifacts-title">Artifacts</span>
        <button className="chat-artifacts-x" title="Close panel" onClick={onClose}>
          ✕
        </button>
      </div>

      {artifacts.length > 1 && (
        <div className="chat-artifacts-tabs">
          {artifacts.map((a) => (
            <button
              key={a.id}
              className={`chat-artifacts-tab ${a.id === active?.id ? "active" : ""}`}
              onClick={() => setActiveId(a.id)}
            >
              {a.title}
            </button>
          ))}
        </div>
      )}

      {active && (
        <div className="chat-artifacts-body">
          <div className="chat-artifacts-bar">
            <span className="chat-artifacts-lang">{active.lang}</span>
            <button className="chat-msg-act" onClick={() => copy(active.code)}>
              Copy source
            </button>
          </div>
          {active.lang === "mermaid" ? (
            <pre className="chat-artifacts-code">{active.code}</pre>
          ) : (
            <iframe
              className="chat-artifacts-frame"
              title={active.title}
              // Opaque origin (no allow-same-origin); allow-scripts only so an
              // HTML artifact can run without touching the host app (§12).
              sandbox="allow-scripts"
              srcDoc={srcDoc(active)}
            />
          )}
        </div>
      )}
    </aside>
  );
}
