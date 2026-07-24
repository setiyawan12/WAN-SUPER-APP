import { randomUUID } from "node:crypto";
import { broadcast } from "./events.js";
import type { ApprovalRequest } from "./cowork-types.js";

// Approval promises (HANDBOOK §8.1 / Jebakan #5). Write/delete/run tools park
// here until the renderer calls chat:approve / chat:reject. Abort rejects all
// pending approvals for a given reqId so the agent loop doesn't hang.

interface Pending {
  reqId: string;
  resolve: (ok: boolean) => void;
}

const pending = new Map<string, Pending>();

export interface ApprovalInput {
  reqId: string;
  tool: string;
  title: string;
  detail: string;
  danger?: boolean;
  diff?: string;
}

export function requestApproval(input: ApprovalInput): Promise<boolean> {
  const id = randomUUID();
  const request: ApprovalRequest = {
    id,
    tool: input.tool,
    title: input.title,
    detail: input.detail,
    danger: !!input.danger,
    diff: input.diff,
  };
  broadcast("chat", { reqId: input.reqId, type: "approval", request });
  return new Promise<boolean>((resolve) => {
    pending.set(id, { reqId: input.reqId, resolve });
  });
}

export function resolveApproval(id: string, ok: boolean): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.resolve(ok);
  return true;
}

/** Reject every pending approval for a chat request (abort / unmount). */
export function rejectApprovalsFor(reqId: string): void {
  for (const [id, p] of pending) {
    if (p.reqId === reqId) {
      pending.delete(id);
      p.resolve(false);
    }
  }
}

export function rejectAllApprovals(): void {
  for (const [id, p] of pending) {
    pending.delete(id);
    p.resolve(false);
  }
}
