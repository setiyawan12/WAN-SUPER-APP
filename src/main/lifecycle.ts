import type { ModuleHandle } from "./module-types.js";

export async function shutdownAll(handles: {
  cliproxy: ModuleHandle | null;
  net: ModuleHandle | null;
  ssh: ModuleHandle | null;
  mindmap: ModuleHandle | null;
}): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (handles.cliproxy?.isRunning()) jobs.push(handles.cliproxy.shutdown());
  if (handles.net?.isRunning()) jobs.push(handles.net.shutdown());
  if (handles.ssh?.isRunning()) jobs.push(handles.ssh.shutdown());
  if (handles.mindmap?.isRunning()) jobs.push(handles.mindmap.shutdown());
  await Promise.allSettled(jobs);
}
