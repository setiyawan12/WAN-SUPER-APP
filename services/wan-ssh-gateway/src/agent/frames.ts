import { GatewayError } from "../errors.js";

export const FRAME_DATA = 1;
export const FRAME_CLOSE = 2;

export function uuidToBytes(id: string) {
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32) throw new GatewayError("MESSAGE_INVALID", "Bridge channel id is invalid");
  return Buffer.from(hex, "hex");
}

export function bytesToUuid(value: Buffer) {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeBridgeFrame(kind: typeof FRAME_DATA | typeof FRAME_CLOSE, channelId: string, payload: Uint8Array = new Uint8Array()) {
  return Buffer.concat([Buffer.from([kind]), uuidToBytes(channelId), Buffer.from(payload)]);
}

export function decodeBridgeFrame(value: Buffer) {
  if (value.length < 17) throw new GatewayError("MESSAGE_INVALID", "Bridge frame is truncated");
  const kind = value[0];
  if (kind !== FRAME_DATA && kind !== FRAME_CLOSE) throw new GatewayError("MESSAGE_INVALID", "Bridge frame type is invalid");
  return { kind, channelId: bytesToUuid(value.subarray(1, 17)), payload: value.subarray(17) };
}
