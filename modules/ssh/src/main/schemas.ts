import { z } from "zod";

export const PasswordSchema = z.string().min(1).max(1024);
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
  tags: z.array(z.string().max(64)).max(50).optional(),
  environment: z.enum(["none", "prod", "staging", "dev"]).optional(),
  favorite: z.boolean().optional(),
  agentForwarding: z.boolean().optional(),
  keepAliveInterval: z.number().int().min(0).max(3600).optional(),
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
export const KeyGenSchema = z.object({
  label: z.string().min(1).max(200),
  algorithm: z.enum(["ed25519", "rsa", "ecdsa"]),
  bits: z.number().int().optional(),
  passphrase: z.string().max(1024).optional()
});
export const KeyImportSchema = z.object({
  label: z.string().min(1).max(200),
  pem: z.string().min(1).max(1e5),
  passphrase: z.string().max(1024).optional()
});
export const IdSchema = z.string().uuid();
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
