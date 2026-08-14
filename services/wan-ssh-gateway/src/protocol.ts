import { z } from "zod";
import { errorCodes, PROTOCOL_VERSION, type ErrorCode } from "./errors.js";

const requestId = z.string().uuid();
const sessionId = z.string().uuid();
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const authMessageSchema = strictObject({
  type: z.literal("auth"),
  requestId,
  protocolVersion: z.literal(PROTOCOL_VERSION),
  mode: z.enum(["dev-anonymous", "firebase"]),
  token: z.string().min(1).max(16_384).optional()
}).superRefine((value, context) => {
  if (value.mode === "firebase" && !value.token) {
    context.addIssue({ code: "custom", path: ["token"], message: "Firebase token is required" });
  }
  if (value.mode === "dev-anonymous" && value.token !== undefined) {
    context.addIssue({ code: "custom", path: ["token"], message: "Development auth does not accept a token" });
  }
});

export const authRefreshMessageSchema = strictObject({
  type: z.literal("auth.refresh"),
  requestId,
  token: z.string().min(1).max(16_384)
});

const targetSchema = strictObject({
  host: z.string().trim().min(1).max(253).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Host contains control characters"),
  port: z.number().int().min(1).max(65_535),
  username: z.string().min(1).max(128).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Username contains control characters")
});

const terminalSchema = strictObject({
  cols: z.number().int().min(1).max(1_000),
  rows: z.number().int().min(1).max(1_000),
  term: z.string().min(1).max(64)
});

const privateKeyAuthenticationSchema = strictObject({
  method: z.literal("privateKey"),
  privateKey: z.string().min(1),
  passphrase: z.string().max(4_096).optional()
});

const passwordAuthenticationSchema = strictObject({
  method: z.literal("password"),
  password: z.string().min(1).max(4_096)
});

export const sessionOpenMessageSchema = strictObject({
  type: z.literal("session.open"),
  requestId,
  target: targetSchema,
  terminal: terminalSchema,
  authentication: z.discriminatedUnion("method", [privateKeyAuthenticationSchema, passwordAuthenticationSchema]),
  expectedHostKeyFingerprint: z.string().max(256).optional()
});

export const sessionInputMessageSchema = strictObject({
  type: z.literal("session.input"),
  sessionId,
  data: z.string().max(65_536)
});

export const sessionResizeMessageSchema = strictObject({
  type: z.literal("session.resize"),
  sessionId,
  cols: z.number().int().min(1).max(1_000),
  rows: z.number().int().min(1).max(1_000)
});

export const sessionCloseMessageSchema = strictObject({
  type: z.literal("session.close"),
  requestId,
  sessionId
});

export const hostKeyAnswerMessageSchema = strictObject({
  type: z.literal("hostkey.answer"),
  requestId,
  sessionId,
  accept: z.boolean()
});

export const authAnswerMessageSchema = strictObject({
  type: z.literal("auth.answer"),
  requestId,
  sessionId,
  answers: z.array(z.string().max(4_096)).max(16)
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  authRefreshMessageSchema,
  sessionOpenMessageSchema,
  sessionInputMessageSchema,
  sessionResizeMessageSchema,
  sessionCloseMessageSchema,
  hostKeyAnswerMessageSchema,
  authAnswerMessageSchema
]);

export type AuthMessage = z.infer<typeof authMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type SessionOpenMessage = z.infer<typeof sessionOpenMessageSchema>;

export type PrincipalView = {
  kind: "development" | "firebase";
  uid: string;
};

export type ServerMessage =
  | { type: "auth.ok"; requestId: string; protocolVersion: 1; principal: PrincipalView; expiresAt?: number }
  | { type: "auth.refreshed"; requestId: string; expiresAt: number }
  | { type: "session.opened"; requestId: string; sessionId: string }
  | { type: "session.closed"; requestId: string; sessionId: string }
  | { type: "session.state"; sessionId: string; state: string; reason?: string; message?: string }
  | { type: "session.output"; sessionId: string; data: string }
  | { type: "session.exit"; sessionId: string; code: number; reason: string; message?: string }
  | { type: "hostkey.prompt"; sessionId: string; kind: "unknown" | "changed"; host: string; port: number; algorithm: string; fingerprint: string; previousFingerprint?: string }
  | { type: "auth.prompt"; sessionId: string; prompts: Array<{ prompt: string; echo: boolean }> }
  | { type: "error"; requestId?: string; sessionId?: string; code: ErrorCode; message: string; retryable: boolean };

export function parseJsonMessage(data: string, maxMessageBytes: number): unknown {
  if (Buffer.byteLength(data, "utf8") > maxMessageBytes) throw new Error("MESSAGE_TOO_LARGE");
  return JSON.parse(data) as unknown;
}

export function parseAuthMessage(value: unknown): AuthMessage {
  return authMessageSchema.parse(value);
}

export function parseClientMessage(value: unknown): ClientMessage {
  return clientMessageSchema.parse(value);
}

export function validatePrivateKeySize(message: SessionOpenMessage, maxPrivateKeyBytes: number) {
  if (message.authentication.method === "privateKey" && Buffer.byteLength(message.authentication.privateKey, "utf8") > maxPrivateKeyBytes) {
    throw new Error("PRIVATE_KEY_TOO_LARGE");
  }
}

export { PROTOCOL_VERSION };