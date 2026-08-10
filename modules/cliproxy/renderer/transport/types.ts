export type RuntimeKind = "desktop-local" | "desktop-cloud" | "web-cloud";

export interface TransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
  requestId?: string;
}

export interface TransportRequest {
  method: string;
  path: string;
  body?: string;
  contentType?: string;
  signal?: AbortSignal;
}

export interface CliproxyTransport {
  readonly kind: RuntimeKind;
  request(input: TransportRequest): Promise<TransportResponse>;
}