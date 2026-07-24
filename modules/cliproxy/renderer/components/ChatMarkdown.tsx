import { useRef, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";
import "highlight.js/styles/github-dark.css";
import { toast } from "./ui";

// HANDBOOK M2 §4.4. Markdown + syntax highlighting for assistant turns. All
// plugins are bundled by Vite from npm (no remote scripts) so the CSP stays
// intact. Links open in the OS browser via the bridge, never navigating the
// app window (§10). Rendering stays light so mid-stream re-renders (content
// grows per token) don't jank (Jebakan #10).

function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  function copy() {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    void window.wan.copyText(text);
    toast.success("Copied");
  }
  return (
    <div className="chat-code">
      <button className="chat-code-copy" onClick={copy} title="Copy code">
        Copy
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void window.wan.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

const components: Components = {
  pre: (props) => <CodeBlock>{props.children}</CodeBlock>,
  a: (props) => <ExternalLink href={props.href}>{props.children}</ExternalLink>,
};

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-md">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
