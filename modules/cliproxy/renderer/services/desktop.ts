import type { WanBridge } from "../wan";

export function hasDesktopServices(): boolean {
  return typeof window !== "undefined" && "wan" in window;
}

export function desktopServices(): WanBridge {
  const services = (window as unknown as { wan?: WanBridge }).wan;
  if (!services) throw new Error("Desktop services are unavailable in this runtime.");
  return services;
}