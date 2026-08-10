import { desktopServices } from "../services/desktop";
import type { ChatStreamEvent } from "../wan";
import type { ChatStreamHandle, ChatTransport } from "./chat";

function isTerminalEvent(event: ChatStreamEvent): boolean {
  return event.type === "done" || event.type === "aborted" || event.type === "error";
}

export class LocalIpcChatTransport implements ChatTransport {
  startChat(
    request: Parameters<ChatTransport["startChat"]>[0],
    listener: Parameters<ChatTransport["startChat"]>[1],
  ): ChatStreamHandle {
    const chat = desktopServices().chat;
    let settled = false;
    let startQueued = true;
    let unsubscribe = () => {};
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;

    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (error === undefined) resolveDone();
      else rejectDone(error);
    };

    unsubscribe = chat.onStream((event) => {
      if (event.reqId !== request.reqId) return;
      try {
        listener(event);
      } finally {
        if (isTerminalEvent(event)) settle();
      }
    });

    queueMicrotask(() => {
      startQueued = false;
      if (settled) return;
      void chat.start(request).catch(settle);
    });

    return {
      abort() {
        if (settled) return;
        if (startQueued) {
          settle();
          return;
        }
        void chat.abort(request.reqId).catch(settle);
      },
      done,
    };
  }
}