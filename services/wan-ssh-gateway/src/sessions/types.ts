import type { Principal } from "../auth/principal.js";
import type { ClientMessage, ServerMessage, SessionOpenMessage } from "../protocol.js";

export interface ConnectionContext {
  id: string;
  principal: Principal;
  send(message: ServerMessage): boolean;
  bufferedAmount(): number;
}

export interface SessionService {
  open(context: ConnectionContext, message: SessionOpenMessage): Promise<string>;
  start(context: ConnectionContext, sessionId: string): void;
  handle(context: ConnectionContext, message: Exclude<ClientMessage, SessionOpenMessage>): Promise<void> | void;
  closeConnection(connectionId: string, reason: string): void;
  closeAll(reason: string): void;
  readonly activeCount: number;
}