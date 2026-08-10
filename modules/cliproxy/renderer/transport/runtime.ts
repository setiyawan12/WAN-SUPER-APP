import { CloudHttpChatTransport } from "./cloud-http-chat";
import { CloudHttpTransport, type AccessTokenProvider } from "./cloud-http";
import { LocalIpcChatTransport } from "./local-ipc-chat";
import { LocalIpcTransport } from "./local-ipc";
import type { ChatTransport } from "./chat";
import type { CliproxyTransport, RuntimeKind } from "./types";

const localTransport = new LocalIpcTransport();
const localChatTransport = new LocalIpcChatTransport();
let configuredKind: RuntimeKind | undefined;
let configuredCloudTransport: CloudHttpTransport | undefined;
let configuredCloudChatTransport: CloudHttpChatTransport | undefined;

export function configureCloudRuntime(options: {
  kind: "desktop-cloud" | "web-cloud";
  baseUrl: string;
  getAccessToken: AccessTokenProvider;
}): void {
  configuredKind = options.kind;
  configuredCloudTransport = new CloudHttpTransport(options);
  configuredCloudChatTransport = new CloudHttpChatTransport(options);
}

export function runtimeKind(): RuntimeKind {
  if (configuredKind) return configuredKind;
  return typeof window !== "undefined" && "wan" in window ? "desktop-local" : "web-cloud";
}

export function cliproxyTransport(): CliproxyTransport {
  if (runtimeKind() === "desktop-local") return localTransport;
  if (configuredCloudTransport) return configuredCloudTransport;
  throw new Error("WAN Router Cloud transport is not configured yet.");
}

export function chatTransport(): ChatTransport {
  if (runtimeKind() === "desktop-local") return localChatTransport;
  if (configuredCloudChatTransport) return configuredCloudChatTransport;
  throw new Error("WAN Router Cloud chat transport is not configured yet.");
}