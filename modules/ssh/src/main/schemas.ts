import { z } from "zod";
import { isLoopbackAddress } from "./security.js";

export const PasswordSchema = z.string().min(1).max(1024);
export const AutoLockSchema = z.number().int().min(60_000).max(24 * 60 * 60 * 1_000);
export const VaultIdSchema = z.enum(["local", "personal"]);
export const HostInputSchema = z.object({
  id: z.string().uuid().optional(),
  vaultId: VaultIdSchema.optional(),
  groupId: z.string().uuid().nullable().optional(),
  label: z.string().min(1).max(200),
  address: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  protocol: z.enum(["ssh", "telnet", "mosh", "local"]).optional(),
  identityId: z.string().uuid().nullable().optional(),
  keyId: z.string().uuid().nullable().optional(),
  jumpHostId: z.string().uuid().nullable().optional(),
  startupSnippetId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  environment: z.enum(["none", "prod", "staging", "dev"]).optional(),
  favorite: z.boolean().optional(),
  agentForwarding: z.boolean().optional(),
  autoReconnect: z.boolean().optional(),
  reconnectLimit: z.number().int().min(0).max(10).optional(),
  keepAliveInterval: z.number().int().min(0).max(3600).optional(),
  openSshAlias: z.string().min(1).max(255).optional(),
  password: z.string().max(1024).optional(),
  username: z.string().max(255).optional()
});
export const GroupDefaultsSchema = z.object({
  username: z.string().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityId: z.string().uuid().optional(),
  keyId: z.string().uuid().optional(),
  envVars: z.record(z.string().max(255), z.string().max(4096)).optional()
});
export const GroupInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().nullable().optional(),
  defaults: GroupDefaultsSchema.optional()
});
export const IdentityInputSchema = z.object({
  id: z.string().uuid().optional(),
  vaultId: VaultIdSchema.optional(),
  label: z.string().min(1).max(200),
  username: z.string().min(1).max(255),
  password: z.string().max(1024).optional(),
  keyId: z.string().uuid().nullable().optional()
});
export const SessionOpenSchema = z.object({
  hostId: z.string().uuid(),
  cols: z.number().int().min(1).max(1e3),
  rows: z.number().int().min(1).max(1e3)
});
export const SessionReconnectSchema = SessionOpenSchema.omit({ hostId: true }).extend({
  sessionId: z.string().uuid()
});
export const SessionAuthAnswerSchema = z.object({
  sessionId: z.string().uuid(),
  answers: z.array(z.string().max(4096)).max(20)
});
export const SessionHostKeyAnswerSchema = z.object({
  sessionId: z.string().uuid(),
  accept: z.boolean()
});
export const LocalSessionOpenSchema = z.object({
  cols: z.number().int().min(1).max(1e3),
  rows: z.number().int().min(1).max(1e3),
  cwd: z.string().max(4096).optional(),
  shell: z.string().max(4096).optional()
});
export const RemotePathSchema = z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "Path tidak valid");
export const TransferListSchema = z.object({
  sessionId: z.string().uuid(),
  path: RemotePathSchema
});
export const TransferActionSchema = z.object({
  sessionId: z.string().uuid(),
  path: RemotePathSchema
});
export const TransferRenameSchema = z.object({
  sessionId: z.string().uuid(),
  from: RemotePathSchema,
  to: RemotePathSchema
});
export const TransferRemoveSchema = TransferActionSchema.extend({ directory: z.boolean() });
export const TransferUploadSchema = z.object({
  sessionId: z.string().uuid(),
  remoteDirectory: RemotePathSchema,
  localPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
  resume: z.boolean().optional()
});
export const TransferDownloadSchema = z.object({
  sessionId: z.string().uuid(),
  remotePath: RemotePathSchema,
  resume: z.boolean().optional()
});
const TunnelBaseSchema = z.object({
  sessionId: z.string().uuid(),
  label: z.string().max(200).optional(),
  bindAddress: z.string().min(1).max(255).refine(isLoopbackAddress, "Tunnel hanya boleh bind ke loopback").optional(),
  bindPort: z.number().int().min(0).max(65535).optional()
});
export const TunnelStartSchema = z.discriminatedUnion("kind", [
  TunnelBaseSchema.extend({
    kind: z.literal("local"),
    targetHost: z.string().min(1).max(255),
    targetPort: z.number().int().min(1).max(65535)
  }),
  TunnelBaseSchema.extend({
    kind: z.literal("remote"),
    targetHost: z.string().min(1).max(255),
    targetPort: z.number().int().min(1).max(65535)
  }),
  TunnelBaseSchema.extend({ kind: z.literal("dynamic") })
]);
export const KeyGenSchema = z.object({
  label: z.string().min(1).max(200),
  algorithm: z.enum(["ed25519", "rsa", "ecdsa"]),
  bits: z.number().int().min(2048).max(8192).optional(),
  passphrase: z.string().max(1024).optional()
});
export const KeyImportSchema = z.object({
  label: z.string().min(1).max(200),
  pem: z.string().min(1).max(1e5),
  passphrase: z.string().max(1024).optional()
});
export const SnippetInputSchema = z.object({
  id: z.string().uuid().optional(),
  vaultId: VaultIdSchema.optional(),
  label: z.string().min(1).max(200),
  command: z.string().min(1).max(20_000),
  description: z.string().max(2_000).optional(),
  tags: z.array(z.string().max(64)).max(50).optional()
});
export const SnippetRunSchema = z.object({
  sessionId: z.string().uuid(),
  snippetId: z.string().uuid(),
  appendNewline: z.boolean().optional()
});
export const RecordingStartSchema = z.object({
  sessionId: z.string().uuid(),
  cols: z.number().int().min(1).max(1e3),
  rows: z.number().int().min(1).max(1e3),
  includeInput: z.boolean().optional()
});
export const AuditListLimitSchema = z.number().int().min(1).max(500);
export const IdSchema = z.string().uuid();
export const RevealPasswordSchema = z.object({
  id: z.string().uuid(),
  password: z.string().max(1024).optional(),
  biometric: z.boolean().optional()
}).refine((value) => Boolean(value.password) || value.biometric === true, "Re-authentication wajib");
export const SignInSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024)
});
export const FirebaseConfigSchema = z.object({
  apiKey: z.string().min(1).max(500),
  authDomain: z.string().min(1).max(500),
  projectId: z.string().min(1).max(200),
  appId: z.string().min(1).max(500),
  /** Wajib untuk Realtime Database (contoh: https://<project>-default-rtdb.firebaseio.com). */
  databaseURL: z.string().url().max(500)
}).passthrough();
