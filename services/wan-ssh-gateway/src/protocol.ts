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

const authenticationSchema = z.discriminatedUnion("method", [privateKeyAuthenticationSchema, passwordAuthenticationSchema]);

const routeHopSchema = strictObject({
  target: targetSchema,
  authentication: authenticationSchema,
  expectedHostKeyFingerprint: z.string().max(256).optional()
});

export const sessionOpenMessageSchema = strictObject({
  type: z.literal("session.open"),
  requestId,
  target: targetSchema,
  terminal: terminalSchema,
  authentication: authenticationSchema,
  expectedHostKeyFingerprint: z.string().max(256).optional(),
  route: strictObject({ jumps: z.array(routeHopSchema).max(5) }).optional(),
  environment: z.record(z.string().max(255), z.string().max(4_096)).optional(),
  startupCommand: z.string().max(20_000).optional(),
  keepAliveInterval: z.number().int().min(0).max(3_600).optional(),
  egress: strictObject({ mode: z.literal("client-agent") }).optional()
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

const remotePath = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"), "Remote path is invalid");

export const sftpHomeMessageSchema = strictObject({ type: z.literal("sftp.home"), requestId, sessionId });
export const sftpListMessageSchema = strictObject({ type: z.literal("sftp.list"), requestId, sessionId, path: remotePath });
export const sftpStatMessageSchema = strictObject({ type: z.literal("sftp.stat"), requestId, sessionId, path: remotePath });
export const sftpMkdirMessageSchema = strictObject({ type: z.literal("sftp.mkdir"), requestId, sessionId, path: remotePath });
export const sftpRenameMessageSchema = strictObject({ type: z.literal("sftp.rename"), requestId, sessionId, from: remotePath, to: remotePath });
export const sftpRemoveMessageSchema = strictObject({ type: z.literal("sftp.remove"), requestId, sessionId, path: remotePath, directory: z.boolean() });
export const sftpWriteMessageSchema = strictObject({
  type: z.literal("sftp.write"),
  requestId,
  sessionId,
  path: remotePath,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  data: z.string().max(400_000),
  truncate: z.boolean()
});
export const sftpReadMessageSchema = strictObject({
  type: z.literal("sftp.read"),
  requestId,
  sessionId,
  path: remotePath,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().min(1).max(196_608)
});

export const tunnelStartMessageSchema = strictObject({
  type: z.literal("tunnel.start"),
  requestId,
  sessionId,
  kind: z.literal("remote"),
  bindAddress: z.string().min(1).max(255),
  bindPort: z.number().int().min(0).max(65_535),
  targetHost: z.string().min(1).max(255),
  targetPort: z.number().int().min(1).max(65_535),
  label: z.string().max(200).optional()
});
export const tunnelListMessageSchema = strictObject({ type: z.literal("tunnel.list"), requestId, sessionId });
export const tunnelStopMessageSchema = strictObject({ type: z.literal("tunnel.stop"), requestId, sessionId, tunnelId: z.string().uuid() });

export const diagnosticsRunMessageSchema = strictObject({
  type: z.literal("diagnostics.run"),
  requestId,
  target: targetSchema.pick({ host: true, port: true }),
  egress: strictObject({ mode: z.literal("client-agent") }).optional()
});
export const knownHostListMessageSchema = strictObject({ type: z.literal("knownhost.list"), requestId });
export const knownHostRemoveMessageSchema = strictObject({ type: z.literal("knownhost.remove"), requestId, host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535) });

export const keyGenerateMessageSchema = strictObject({
  type: z.literal("key.generate"),
  requestId,
  algorithm: z.enum(["ed25519", "ecdsa", "rsa"]),
  bits: z.number().int().min(2_048).max(8_192).optional(),
  passphrase: z.string().max(4_096).optional()
});
export const keyInspectMessageSchema = strictObject({ type: z.literal("key.inspect"), requestId, privateKey: z.string().min(1), passphrase: z.string().max(4_096).optional() });
export const keyInstallMessageSchema = strictObject({ type: z.literal("key.install"), requestId, sessionId, publicKey: z.string().min(1).max(32_768) });

export const clientMessageSchema = z.discriminatedUnion("type", [
  authRefreshMessageSchema,
  sessionOpenMessageSchema,
  sessionInputMessageSchema,
  sessionResizeMessageSchema,
  sessionCloseMessageSchema,
  hostKeyAnswerMessageSchema,
  authAnswerMessageSchema,
  sftpHomeMessageSchema,
  sftpListMessageSchema,
  sftpStatMessageSchema,
  sftpMkdirMessageSchema,
  sftpRenameMessageSchema,
  sftpRemoveMessageSchema,
  sftpWriteMessageSchema,
  sftpReadMessageSchema,
  tunnelStartMessageSchema,
  tunnelListMessageSchema,
  tunnelStopMessageSchema,
  diagnosticsRunMessageSchema,
  knownHostListMessageSchema,
  knownHostRemoveMessageSchema,
  keyGenerateMessageSchema,
  keyInspectMessageSchema,
  keyInstallMessageSchema
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
  | { type: "sftp.home.result"; requestId: string; sessionId: string; path: string }
  | { type: "sftp.list.result"; requestId: string; sessionId: string; entries: Array<{ name: string; path: string; type: "directory" | "file" | "symlink"; size: number; mode: number; modifiedAt: number }> }
  | { type: "sftp.stat.result"; requestId: string; sessionId: string; entry: { name: string; path: string; type: "directory" | "file" | "symlink"; size: number; mode: number; modifiedAt: number } }
  | { type: "sftp.mutation.result"; requestId: string; sessionId: string; ok: true }
  | { type: "sftp.write.result"; requestId: string; sessionId: string; written: number }
  | { type: "sftp.read.result"; requestId: string; sessionId: string; data: string; bytesRead: number; size: number; eof: boolean }
  | { type: "tunnel.result"; requestId: string; sessionId: string; tunnels: Array<{ id: string; sessionId: string; kind: "remote"; label: string; bindAddress: string; bindPort: number; targetHost: string; targetPort: number; state: "active" | "stopping" | "error"; error?: string }> }
  | { type: "tunnel.changed"; sessionId: string; tunnels: Array<{ id: string; sessionId: string; kind: "remote"; label: string; bindAddress: string; bindPort: number; targetHost: string; targetPort: number; state: "active" | "stopping" | "error"; error?: string }> }
  | { type: "diagnostics.result"; requestId: string; address: string; port: number; phases: Array<{ name: "resolve" | "tcp"; ok: boolean; durationMs: number; detail: string }> }
  | { type: "knownhost.list.result"; requestId: string; entries: Array<{ id: string; hostPattern: string; fingerprint: string; keyType: string; vaultId: "personal"; firstSeenAt: number; updatedAt: number }> }
  | { type: "knownhost.removed"; requestId: string; removed: boolean }
  | { type: "key.generated"; requestId: string; privateKey: string; publicKey: string; algorithm: string; bits: number | null; fingerprintSha256: string }
  | { type: "key.inspected"; requestId: string; publicKey: string; algorithm: string; bits: number | null; fingerprintSha256: string }
  | { type: "key.installed"; requestId: string; sessionId: string; installed: true }
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
  for (const hop of message.route?.jumps ?? []) {
    if (hop.authentication.method === "privateKey" && Buffer.byteLength(hop.authentication.privateKey, "utf8") > maxPrivateKeyBytes) {
      throw new Error("PRIVATE_KEY_TOO_LARGE");
    }
  }
}

export { PROTOCOL_VERSION };