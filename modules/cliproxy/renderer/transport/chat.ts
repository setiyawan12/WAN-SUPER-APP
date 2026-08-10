import type { ChatStartInit, ChatStreamEvent } from "../wan";

export interface ChatStreamHandle {
  abort(): void;
  done: Promise<void>;
}

export interface ChatTransport {
  startChat(
    request: ChatStartInit,
    listener: (event: ChatStreamEvent) => void,
  ): ChatStreamHandle;
}