import { z } from "zod";
import { PROTOCOL_VERSION } from "../errors.js";

const requestId = z.string().uuid();
const channelId = z.string().uuid();
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const agentRegisterMessageSchema = strictObject({
  type: z.literal("agent.register"),
  requestId,
  protocolVersion: z.literal(PROTOCOL_VERSION),
  mode: z.enum(["dev-anonymous", "firebase"]),
  token: z.string().min(1).max(16_384).optional()
}).superRefine((value, context) => {
  if (value.mode === "firebase" && !value.token) context.addIssue({ code: "custom", path: ["token"], message: "Firebase token is required" });
  if (value.mode === "dev-anonymous" && value.token !== undefined) context.addIssue({ code: "custom", path: ["token"], message: "Development auth does not accept a token" });
});

export const agentRefreshMessageSchema = strictObject({
  type: z.literal("agent.auth.refresh"),
  requestId,
  token: z.string().min(1).max(16_384)
});

export const bridgeOpenMessageSchema = strictObject({
  type: z.literal("bridge.open"),
  requestId,
  channelId,
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535)
});

export const bridgeOpenedMessageSchema = strictObject({
  type: z.literal("bridge.opened"),
  requestId,
  channelId
});

export const bridgeFailedMessageSchema = strictObject({
  type: z.literal("bridge.failed"),
  requestId,
  channelId,
  message: z.string().min(1).max(500)
});

export type AgentRegisterMessage = z.infer<typeof agentRegisterMessageSchema>;
export type BridgeOpenMessage = z.infer<typeof bridgeOpenMessageSchema>;
