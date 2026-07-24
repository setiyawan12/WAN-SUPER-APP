import type { ModuleHandle } from "./module-types.js";

export async function shutdownAll(handles: {
  cliproxy: ModuleHandle | null;
  net: ModuleHandle | null;
}): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (handles.cliproxy?.isRunning()) jobs.push(handles.cliproxy.shutdown());
  if (handles.net?.isRunning()) jobs.push(handles.net.shutdown());
  await Promise.allSettled(jobs);
}
