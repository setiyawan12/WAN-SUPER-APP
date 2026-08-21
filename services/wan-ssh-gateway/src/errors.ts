export const PROTOCOL_VERSION = 1 as const;

export const errorCodes = [
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "ORIGIN_DENIED",
  "PROTOCOL_UNSUPPORTED",
  "MESSAGE_INVALID",
  "SESSION_NOT_FOUND",
  "SESSION_LIMIT",
  "RATE_LIMIT",
  "TARGET_DENIED",
  "SSH_TIMEOUT",
  "SSH_AUTH_FAILED",
  "SSH_HOST_KEY_REJECTED",
  "SSH_CONNECTION_FAILED",
  "SFTP_FAILED",
  "TUNNEL_FAILED",
  "DIAGNOSTICS_FAILED",
  "KEY_OPERATION_FAILED",
  "AGENT_UNAVAILABLE",
  "AGENT_CONNECTION_FAILED",
  "BACKPRESSURE_LIMIT",
  "IDLE_TIMEOUT",
  "INTERNAL"
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const closeCodes = {
  invalidMessage: 4400,
  authentication: 4401,
  policyDenied: 4403,
  authenticationTimeout: 4408,
  limit: 4429,
  internal: 4500,
  serviceRestart: 1012
} as const;

export const CLOSE_CODES = {
  messageInvalid: closeCodes.invalidMessage,
  authInvalid: closeCodes.authentication,
  policyDenied: closeCodes.policyDenied,
  authTimeout: closeCodes.authenticationTimeout,
  limit: closeCodes.limit,
  internal: closeCodes.internal,
  serviceRestart: closeCodes.serviceRestart
} as const;

export class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly closeCode?: number
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("INTERNAL", "Internal gateway error");
}