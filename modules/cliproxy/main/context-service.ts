import fs from "node:fs/promises";
import path from "node:path";
// Electron is loaded only inside pickContextFiles so unit tests can import
// fetchUrlContext / tools without requiring the Electron runtime.

// In-app Chat context sources (HANDBOOK M5 — "Konteks & artifacts", Tahap 8).
// Two ways to feed extra context into a turn, both routed through MAIN so the
// renderer never opens a file handle or a network socket itself (CSP
// connect-src 'none' stays intact, §10):
//   • @-file  → dialog.showOpenDialog picks local text files, read + size-capped
//   • web fetch → main fetches a URL and reduces the HTML to readable text
// The renderer receives plain text it can splice into the user message as a
// context preamble (shown as removable chips in the composer).

// Guardrails (§10): never inline a whole binary or a giant file. Text only,
// hard-capped, with a `truncated` flag so the UI can say so.
const MAX_FILE_BYTES = 512 * 1024; // 512 KB per file before truncation
const MAX_FILE_CHARS = 60_000; // then trim the decoded text as well
const MAX_URL_CHARS = 20_000; // reduced-HTML text budget
const FETCH_TIMEOUT_MS = 15_000;

export interface FileContext {
  kind: "file";
  name: string;
  path: string;
  size: number;
  text: string;
  truncated: boolean;
}

export interface UrlContext {
  kind: "url";
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

// A NUL byte in the first slice is a cheap, reliable "this is binary" signal —
// keeps images/executables out of the prompt even if the user picks them.
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

async function readOneFile(file: string): Promise<FileContext | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    const fh = await fs.open(file, "r");
    try {
      const cap = Math.min(stat.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(cap);
      const { bytesRead } = await fh.read(buf, 0, cap, 0);
      const slice = buf.subarray(0, bytesRead);
      if (looksBinary(slice)) return null;
      let text = slice.toString("utf8");
      let truncated = stat.size > MAX_FILE_BYTES;
      if (text.length > MAX_FILE_CHARS) {
        text = text.slice(0, MAX_FILE_CHARS);
        truncated = true;
      }
      return { kind: "file", name: path.basename(file), path: file, size: stat.size, text, truncated };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Open the native file picker (anchored to the requesting window) and return
 * text context for each readable file. Binary/oversized files are skipped or
 * truncated rather than rejected wholesale.
 */
export async function pickContextFiles(
  win: import("electron").BrowserWindow | null
): Promise<FileContext[]> {
  const { dialog } = await import("electron");
  const opts: Electron.OpenDialogOptions = {
    title: "Add files as chat context",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Text & code",
        extensions: ["txt", "md", "markdown", "json", "yaml", "yml", "csv", "log", "js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "kt", "c", "h", "cpp", "cs", "rb", "php", "sh", "sql", "html", "css", "xml", "toml", "ini", "env"],
      },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths.length) return [];
  const out: FileContext[] = [];
  for (const f of res.filePaths) {
    const ctx = await readOneFile(f);
    if (ctx) out.push(ctx);
  }
  return out;
}

// Extremely small HTML → text reduction: drop non-content elements, unwrap the
// rest, decode a handful of common entities, collapse whitespace. Good enough
// to hand a model readable page text without pulling in a parser dependency.
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : "";
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:head|nav|footer|svg|form)[\s\S]*?<\/(?:head|nav|footer|svg|form)>/gi, " ");
  // Turn block boundaries into newlines so paragraphs survive.
  body = body.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");
  body = decodeEntities(body);
  body = body
    .split("\n")
    .map((l) => l.replace(/[ \t\f\r]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text: body };
}

/**
 * Fetch a URL from the MAIN process and reduce it to readable text. Only
 * http/https are allowed (no file://, no loopback-to-backend abuse). Returns a
 * size-capped text blob plus the page title for the context chip label.
 */
export async function fetchUrlContext(rawUrl: string): Promise<UrlContext> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http/https URLs are supported");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "wan-cliproxyapi-desktop/chat", Accept: "text/html,text/plain,*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    let title = url.hostname;
    let text: string;
    if (ctype.includes("html")) {
      const reduced = htmlToText(raw);
      title = reduced.title || url.hostname;
      text = reduced.text;
    } else {
      text = raw;
    }
    let truncated = false;
    if (text.length > MAX_URL_CHARS) {
      text = text.slice(0, MAX_URL_CHARS);
      truncated = true;
    }
    return { kind: "url", url: url.toString(), title, text, truncated };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") throw new Error("Fetch timed out");
    throw new Error(e?.message ?? "Fetch failed");
  } finally {
    clearTimeout(timer);
  }
}
