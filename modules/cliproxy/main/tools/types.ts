import type { ToolCallView } from "../cowork-types.js";

// Shared tool interfaces (HANDBOOK §5). Implementations live in fs-read / fs-write / run.

export interface ToolCtx {
  emit: (patch: Partial<ToolCallView>) => void;
  signal?: AbortSignal;
}

export interface ApprovalPreview {
  title: string;
  detail: string;
  danger: boolean;
  diff?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: object;
  needsApproval: boolean;
  danger?: boolean;
  /** Build the approval card content BEFORE side effects. */
  prepareApproval?: (args: Record<string, unknown>) => ApprovalPreview;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string>;
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function safeJsonArgs(args: Record<string, unknown>): Record<string, unknown> {
  return args ?? {};
}
