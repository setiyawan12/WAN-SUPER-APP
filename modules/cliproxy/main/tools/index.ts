import type { Tool } from "./types.js";
import { FS_READ_TOOLS } from "./fs-read.js";
import { FS_WRITE_TOOLS } from "./fs-write.js";
import { RUN_TOOLS } from "./run.js";
import { CHAT_TOOLS } from "./fetch-url.js";

// Cowork tool registry (HANDBOOK §5–§9 / §16). Schemas go to the model; run()
// executes in MAIN only. needsApproval tools present a preview via prepareApproval()
// BEFORE writing anything (Jebakan #7).

export type { Tool, ToolCtx, ApprovalPreview } from "./types.js";
export { looksBinary, safeJsonArgs } from "./types.js";
export { isBlockedCommand } from "./run.js";

export const COWORK_TOOLS: Tool[] = [...FS_READ_TOOLS, ...FS_WRITE_TOOLS, ...RUN_TOOLS];
export { CHAT_TOOLS };

export function toolsForSession(opts: { useTools?: boolean; cowork?: boolean }): Tool[] {
  const out: Tool[] = [];
  if (opts.useTools) out.push(...CHAT_TOOLS);
  if (opts.cowork) out.push(...COWORK_TOOLS);
  return out;
}

export function toolSchemas(tools: Tool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function byName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
