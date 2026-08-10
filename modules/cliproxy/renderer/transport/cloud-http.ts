import type { CliproxyTransport, TransportRequest, TransportResponse } from "./types";

export type AccessTokenProvider = () => Promise<string>;

export interface CloudHttpTransportOptions {
  baseUrl: string;
  getAccessToken: AccessTokenProvider;
  kind?: "desktop-cloud" | "web-cloud";
}

export function normalizeCloudBaseUrl(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("WAN Router Cloud requires HTTPS outside local development.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("WAN Router Cloud base URL cannot contain credentials, query parameters, or fragments.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export class CloudHttpTransport implements CliproxyTransport {
  readonly kind: "desktop-cloud" | "web-cloud";
  private readonly baseUrl: string;

  constructor(private readonly options: CloudHttpTransportOptions) {
    this.kind = options.kind ?? "web-cloud";
    this.baseUrl = normalizeCloudBaseUrl(options.baseUrl);
  }

  async request(input: TransportRequest): Promise<TransportResponse> {
    if (!input.path.startsWith("/")) throw new Error("Cloud transport paths must be absolute.");
    const token = await this.options.getAccessToken();
    if (!token) throw new Error("A signed-in WAN session is required.");

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });
    if (input.body !== undefined) headers.set("Content-Type", input.contentType || "application/json");

    const response = await fetch(`${this.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      body: input.body,
      signal: input.signal,
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: await response.text(),
      requestId: response.headers.get("x-request-id") || undefined,
    };
  }
}