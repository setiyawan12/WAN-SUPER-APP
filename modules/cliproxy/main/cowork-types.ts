// Shared Cowork Mode types (HANDBOOK-WAN-COWORK-MODE). Type-only surface is
// mirrored in the renderer via wan.d.ts so the preload bridge stays typed.

export interface CoworkProject {
  id: string;
  name: string; // basename of the folder
  root: string; // absolute path
  git: boolean;
  addedAt: number;
}

/** Full Cowork session state returned by `cowork:state` (includes undo gate). */
export interface CoworkState {
  project: CoworkProject | null;
  canUndo: boolean;
  lastCheckpoint: string | null;
}

export type ToolStatus = "running" | "ok" | "error" | "rejected" | "aborted";

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  summary?: string;
  diff?: string;
  output?: string;
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  title: string;
  detail: string;
  danger: boolean;
  diff?: string;
}
