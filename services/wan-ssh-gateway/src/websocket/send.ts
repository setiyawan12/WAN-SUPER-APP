import WebSocket from "ws";
import type { ServerMessage } from "../protocol.js";

export function sendMessage(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}