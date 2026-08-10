import { EventEmitter } from "node:events";
import { GatewayError } from "../errors.js";

export type BackpressureWritable = EventEmitter & {
  destroyed: boolean;
  write(chunk: string): boolean;
};

async function writeChunk(destination: BackpressureWritable, chunk: string): Promise<void> {
  if (destination.destroyed) {
    throw new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request.");
  }
  if (destination.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      destination.off("drain", onDrain);
      destination.off("close", onClose);
      destination.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request."));
    };
    const onError = () => {
      cleanup();
      reject(new GatewayError(502, "api_error", "downstream_write_failed", "The gateway could not write the stream response."));
    };
    destination.once("drain", onDrain);
    destination.once("close", onClose);
    destination.once("error", onError);
  });
}

export async function writeSseJson(destination: BackpressureWritable, payload: unknown): Promise<void> {
  await writeChunk(destination, `data: ${JSON.stringify(payload)}\n\n`);
}

export async function writeSseDone(destination: BackpressureWritable): Promise<void> {
  await writeChunk(destination, "data: [DONE]\n\n");
}