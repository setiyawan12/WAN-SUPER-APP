import { desktopServices } from "../services/desktop";
import type { CliproxyTransport, TransportRequest, TransportResponse } from "./types";

export class LocalIpcTransport implements CliproxyTransport {
  readonly kind = "desktop-local" as const;

  async request(input: TransportRequest): Promise<TransportResponse> {
    if (input.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

    const response = await desktopServices().request({
      method: input.method,
      path: input.path,
      body: input.body,
      contentType: input.contentType,
    });

    return response;
  }
}