import type { NormalizedChatRequest } from "../inference/contracts.js";

export interface PreparedChatAdmission {
  request: NormalizedChatRequest;
  requestedTokens: number;
}

export function prepareChatAdmission(
  request: NormalizedChatRequest,
  defaultMaxCompletionTokens: number,
): PreparedChatAdmission {
  if (!Number.isInteger(defaultMaxCompletionTokens) || defaultMaxCompletionTokens < 1) {
    throw new Error("defaultMaxCompletionTokens must be a positive integer.");
  }
  const hasExplicitLimit = request.max_tokens !== undefined || request.max_completion_tokens !== undefined;
  const completionTokens = request.max_completion_tokens ?? request.max_tokens ?? defaultMaxCompletionTokens;
  const effectiveRequest = hasExplicitLimit
    ? request
    : { ...request, max_completion_tokens: completionTokens };
  const requestBytes = Buffer.byteLength(JSON.stringify(effectiveRequest), "utf8");
  return {
    request: effectiveRequest,
    requestedTokens: requestBytes + completionTokens,
  };
}