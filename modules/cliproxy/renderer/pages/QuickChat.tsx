import { useEffect, useRef, useState } from "react";
import { api, type ModelEntry } from "../api/client";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { ModelPicker } from "../components/ModelPicker";
import type { ChatStreamEvent } from "../wan";
import { chatTransport } from "../transport/runtime";
import type { ChatStreamHandle } from "../transport/chat";

// Quick-chat view (HANDBOOK M6 — Tahap 9). The minimal chat rendered inside the
// frameless mini window (main.tsx routes here on location.hash === "#quick").
// Same streaming bridge as the full page, trimmed to one-off asks: no history
// store, no sidebar. Esc dismisses the window; "Open full chat" hands off to
// the dashboard.

interface QMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: string;
}

export function QuickChat() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [model, setModel] = useState("");
  const [messages, setMessages] = useState<QMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<ChatStreamHandle | null>(null);
  const reqRef = useRef<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void api
      .getModels()
      .then((res) => {
        const enabled = res.models.filter((m) => m.enabled);
        setModels(enabled);
        setModel((cur) => cur || enabled[0]?.id || "");
      })
      .catch(() => {});
    taRef.current?.focus();
    return () => streamRef.current?.abort();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function close() {
    void window.wan.quick.hide();
  }

  function openFull() {
    void window.wan.focus();
    close();
  }

  function send() {
    const text = input.trim();
    if (!text || busy || !model) return;
    const aid = crypto.randomUUID();
    const useModel = model;
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: "user", content: text },
      { id: aid, role: "assistant", content: "", streaming: true },
    ]);
    const history = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];
    setInput("");
    setBusy(true);

    const reqId = crypto.randomUUID();
    reqRef.current = reqId;
    const handle = chatTransport().startChat({ reqId, model: useModel, messages: history }, (ev: ChatStreamEvent) => {
      if (ev.reqId !== reqId) return;
      if (ev.type === "delta") {
        setMessages((m) => m.map((x) => (x.id === aid ? { ...x, content: x.content + ev.text } : x)));
      } else if (ev.type === "done" || ev.type === "aborted") {
        streamRef.current = null;
        setBusy(false);
        setMessages((m) => m.map((x) => (x.id === aid ? { ...x, streaming: false } : x)));
      } else if (ev.type === "error") {
        streamRef.current = null;
        setBusy(false);
        setMessages((m) => m.map((x) => (x.id === aid ? { ...x, streaming: false, error: ev.error } : x)));
      }
    });
    streamRef.current = handle;
    void handle.done.catch((error: unknown) => {
      if (reqRef.current !== reqId) return;
      streamRef.current = null;
      setBusy(false);
      setMessages((items) => items.map((item) => (
        item.id === aid
          ? { ...item, streaming: false, error: error instanceof Error ? error.message : String(error) }
          : item
      )));
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy) streamRef.current?.abort();
      else close();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="quick-shell">
      <div className="quick-head">
        <span className="quick-brand">Ask AI</span>
        <ModelPicker models={models} value={model} onChange={setModel} />
        <div className="quick-head-actions">
          <button className="chat-msg-act" onClick={openFull} title="Open the full chat">
            Full chat ↗
          </button>
          <button className="quick-x" onClick={close} title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>

      <div className="quick-thread" ref={scrollRef}>
        {!messages.length && (
          <div className="quick-empty">
            <p>Ask a quick question.</p>
            <p className="page-hint">Enter to send · Esc to dismiss</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">
              {m.role === "assistant" ? (
                <>
                  <ChatMarkdown content={m.content} />
                  {m.streaming && <span className="chat-cursor">▍</span>}
                </>
              ) : (
                m.content
              )}
              {m.error && <span className="chat-error">{m.error}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="quick-composer">
        <textarea
          ref={taRef}
          className="text-input chat-input"
          value={input}
          placeholder={model ? "Ask anything…" : "Enable a model first"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={!model}
        />
        {busy ? (
          <button className="btn danger chat-send" onClick={() => streamRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="btn chat-send" onClick={send} disabled={!input.trim() || !model}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
