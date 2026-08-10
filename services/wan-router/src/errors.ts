export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface NormalizedErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
    request_id: string;
  };
}

export function normalizeError(error: unknown, requestId: string): {
  status: number;
  body: NormalizedErrorBody;
} {
  const normalized = error instanceof GatewayError
    ? error
    : new GatewayError(500, "api_error", "internal_error", "The gateway could not complete the request.");

  return {
    status: normalized.status,
    body: {
      error: {
        message: normalized.message,
        type: normalized.type,
        code: normalized.code,
        request_id: requestId,
      },
    },
  };
}