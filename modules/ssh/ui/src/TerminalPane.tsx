import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { RemoteTerminalTransport } from "./transport/contract";

export type TerminalHandle = {
  focus: () => void;
  openSearch: () => void;
  clear: () => void;
  copy: () => Promise<void>;
  paste: () => Promise<void>;
  selection: () => string;
  dimensions: () => { cols: number; rows: number };
};

type Props = {
  sessionId: string;
  /** Pane sedang dirender di grid (bukan tab tersembunyi). */
  visible: boolean;
  /** Pane sedang difokuskan — hanya satu pane yang aktif. */
  active: boolean;
  label: string;
  transport: RemoteTerminalTransport;
  mockBanner?: boolean;
};

const theme = {
  background: "#101311",
  foreground: "#e7ebe6",
  cursor: "#63c694",
  cursorAccent: "#101311",
  selectionBackground: "rgba(99, 198, 148, .28)",
  black: "#101311",
  brightBlack: "#68716b",
  red: "#e06c68",
  green: "#63c694",
  yellow: "#d7aa58",
  blue: "#78a7d4",
  magenta: "#b79ac8",
  cyan: "#69b7b2",
  white: "#e7ebe6"
};

export const TerminalPane = forwardRef<TerminalHandle, Props>(function TerminalPane({ sessionId, visible, active, label, transport, mockBanner = false }, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");

  useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus(),
    openSearch: () => setSearchOpen(true),
    clear: () => terminalRef.current?.clear(),
    copy: async () => {
      const selection = terminalRef.current?.getSelection();
      if (selection) await navigator.clipboard.writeText(selection);
    },
    paste: async () => {
      const text = await navigator.clipboard.readText();
      if (text) terminalRef.current?.paste(text);
    },
    selection: () => terminalRef.current?.getSelection() ?? "",
    dimensions: () => ({ cols: terminalRef.current?.cols ?? 80, rows: terminalRef.current?.rows ?? 24 })
  }), []);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      fontWeight: 430,
      letterSpacing: 0,
      lineHeight: 1.28,
      macOptionIsMeta: true,
      scrollback: 20_000,
      theme
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.open(mount);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch {
    }
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;

    const resize = () => {
      // Tab tersembunyi berukuran 1×1px — fit() di sana merusak jumlah kolom.
      if (!visibleRef.current) return;
      try {
        fit.fit();
        transport.resize(sessionId, terminal.cols, terminal.rows);
      } catch {
      }
    };
    const frame = requestAnimationFrame(resize);
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    const dataSubscription = terminal.onData((data) => transport.write(sessionId, data));
    const offEvents = transport.onEvent((event) => {
      if (event.type === "session.output" && event.sessionId === sessionId) terminal.write(event.data);
    });
    if (mockBanner) {
      terminal.writeln(`\x1b[1;32m${label}\x1b[0m  connected`);
      terminal.writeln("Linux wan-node 6.8.0 #1 SMP");
      terminal.write("\r\n\x1b[38;5;108mdeploy@api-prod\x1b[0m:\x1b[38;5;110m~/services\x1b[0m$ ");
    }
    const keyHandler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && activeRef.current) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", keyHandler);
    terminal.focus();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataSubscription.dispose();
      offEvents();
      window.removeEventListener("keydown", keyHandler);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [label, sessionId, transport]);

  useEffect(() => {
    if (!visible) return;
    // Double-rAF: frame pertama menunggu layout selesai setelah pane tampil
    // kembali, frame kedua memastikan dimensi stabil sebelum FitAddon mengukur.
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const t = terminalRef.current;
          if (t) transport.resize(sessionId, t.cols, t.rows);
        } catch {}
        if (activeRef.current) terminalRef.current?.focus();
      });
    });
    let inner: number;
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [visible, active, sessionId, transport]);

  const find = (previous = false) => {
    if (!query) return;
    if (previous) searchRef.current?.findPrevious(query, { incremental: false });
    else searchRef.current?.findNext(query, { incremental: false });
  };

  return (
    <div className="terminal-pane" data-session-id={sessionId} onMouseDown={() => terminalRef.current?.focus()}>
      <div className="terminal-mount" ref={mountRef} />
      {searchOpen && (
        <div className="terminal-search" role="search">
          <Search size={14} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder="Cari output"
            onChange={(event) => {
              setQuery(event.target.value);
              searchRef.current?.findNext(event.target.value, { incremental: true });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") find(event.shiftKey);
              if (event.key === "Escape") setSearchOpen(false);
            }}
          />
          <button className="icon-button compact" onClick={() => find(true)} title="Hasil sebelumnya">↑</button>
          <button className="icon-button compact" onClick={() => find(false)} title="Hasil berikutnya">↓</button>
          <button className="icon-button compact" onClick={() => setSearchOpen(false)} title="Tutup pencarian"><X size={14} /></button>
        </div>
      )}
    </div>
  );
});