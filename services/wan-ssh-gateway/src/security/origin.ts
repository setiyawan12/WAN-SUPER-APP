import type { GatewayConfig } from "../config.js";
import { CLOSE_CODES, GatewayError } from "../errors.js";

export function assertAllowedOrigin(config: GatewayConfig, origin: string | undefined) {
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new GatewayError("ORIGIN_DENIED", "WebSocket origin is not allowed", false, CLOSE_CODES.policyDenied);
  }
}