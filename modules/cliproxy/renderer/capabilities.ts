import { runtimeKind } from "./transport/runtime";
import type { RuntimeKind } from "./transport/types";

export interface RuntimeCapabilities {
  serverLifecycle: boolean;
  localAuthFiles: boolean;
  ideSync: boolean;
  cliToolConfig: boolean;
  coworkFilesystem: boolean;
  terminal: boolean;
  cloudApiKeys: boolean;
  cloudProviderKeys: boolean;
  cloudUsage: boolean;
}

const CAPABILITIES: Record<RuntimeKind, RuntimeCapabilities> = {
  "desktop-local": {
    serverLifecycle: true,
    localAuthFiles: true,
    ideSync: true,
    cliToolConfig: true,
    coworkFilesystem: true,
    terminal: true,
    cloudApiKeys: false,
    cloudProviderKeys: false,
    cloudUsage: false,
  },
  "desktop-cloud": {
    serverLifecycle: false,
    localAuthFiles: false,
    ideSync: true,
    cliToolConfig: true,
    coworkFilesystem: true,
    terminal: true,
    cloudApiKeys: true,
    cloudProviderKeys: true,
    cloudUsage: true,
  },
  "web-cloud": {
    serverLifecycle: false,
    localAuthFiles: false,
    ideSync: false,
    cliToolConfig: false,
    coworkFilesystem: false,
    terminal: false,
    cloudApiKeys: true,
    cloudProviderKeys: true,
    cloudUsage: true,
  },
};

export function runtimeCapabilities(kind: RuntimeKind = runtimeKind()): RuntimeCapabilities {
  return CAPABILITIES[kind];
}