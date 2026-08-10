import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProviderCredentialRecord,
  ProviderCredentialStatus,
  RouterRepository,
  UpdateProviderCredentialRecord,
} from "../data/repository.js";
import { GatewayError } from "../errors.js";
import type { ProviderVerifierRegistry } from "../providers/credentials.js";
import type { EncryptedPayload, EnvelopeCipher } from "../security/envelope.js";

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MODEL_FILTER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;

const createSchema = z.object({
  provider: z.string().regex(PROVIDER_PATTERN),
  name: z.string().trim().min(1).max(80),
  secret: z.string().min(8).max(16_384),
  modelFilters: z.array(z.string().regex(MODEL_FILTER_PATTERN)).max(128).default([]),
  priority: z.number().int().min(-1000).max(1000).default(0),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  secret: z.string().min(8).max(16_384).optional(),
  modelFilters: z.array(z.string().regex(MODEL_FILTER_PATTERN)).max(128).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "At least one provider credential field is required.");

export interface ProviderCredentialView {
  id: string;
  provider: string;
  name: string;
  maskedValue: string;
  modelFilters: string[];
  priority: number;
  status: ProviderCredentialStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  createdAt: string;
  rotatedAt: string | null;
  updatedAt: string;
}

export interface ProviderCredentialCandidate {
  id: string;
  revision: string;
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return `${secret.slice(0, 2)}...${secret.slice(-2)}`;
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function context(workspaceId: string, id: string, provider: string): string {
  return `${workspaceId}:${id}:${provider}`;
}

function encryptedFromRecord(record: ProviderCredentialRecord): EncryptedPayload {
  return {
    ciphertext: record.ciphertext,
    ciphertextIv: record.ciphertextIv,
    ciphertextTag: record.ciphertextTag,
    wrappedKey: record.wrappedKey,
    wrappedKeyIv: record.wrappedKeyIv,
    wrappedKeyTag: record.wrappedKeyTag,
    keyVersion: record.keyVersion,
  };
}

function encryptedPatch(payload: EncryptedPayload): UpdateProviderCredentialRecord {
  return {
    ciphertext: payload.ciphertext,
    ciphertextIv: payload.ciphertextIv,
    ciphertextTag: payload.ciphertextTag,
    wrappedKey: payload.wrappedKey,
    wrappedKeyIv: payload.wrappedKeyIv,
    wrappedKeyTag: payload.wrappedKeyTag,
    keyVersion: payload.keyVersion,
  };
}

function view(record: ProviderCredentialRecord): ProviderCredentialView {
  return {
    id: record.id,
    provider: record.provider,
    name: record.name,
    maskedValue: record.maskedValue,
    modelFilters: [...record.modelFilters],
    priority: record.priority,
    status: record.status,
    lastVerifiedAt: record.lastVerifiedAt?.toISOString() ?? null,
    lastVerificationError: record.lastVerificationError,
    createdAt: record.createdAt.toISOString(),
    rotatedAt: record.rotatedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

function parseError(error: z.ZodError): GatewayError {
  return new GatewayError(
    400,
    "invalid_request_error",
    "invalid_provider_credential",
    error.issues[0]?.message || "The provider credential request is invalid.",
  );
}

export class ProviderCredentialService {
  private readonly enabledProviderSet: ReadonlySet<string>;

  constructor(
    private readonly repository: RouterRepository,
    private readonly cipher: EnvelopeCipher,
    private readonly verifiers: ProviderVerifierRegistry,
    enabledProviders: readonly string[] = verifiers.providers(),
  ) {
    this.enabledProviderSet = new Set(enabledProviders);
  }

  enabledProviders(): string[] {
    return [...this.enabledProviderSet].sort();
  }

  async create(workspaceId: string, input: unknown): Promise<ProviderCredentialView> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw parseError(parsed.error);
    this.requireProviderEnabled(parsed.data.provider);
    const id = randomUUID();
    const encrypted = await this.cipher.encrypt(parsed.data.secret, context(workspaceId, id, parsed.data.provider));
    try {
      return view(await this.repository.createProviderCredential({
        id,
        workspaceId,
        provider: parsed.data.provider,
        name: parsed.data.name,
        ...encrypted,
        maskedValue: maskSecret(parsed.data.secret),
        modelFilters: [...new Set(parsed.data.modelFilters)],
        priority: parsed.data.priority,
      }));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new GatewayError(409, "conflict_error", "credential_name_conflict", "A provider credential with this name already exists.");
      }
      throw error;
    }
  }

  async list(workspaceId: string): Promise<ProviderCredentialView[]> {
    return (await this.repository.listProviderCredentials(workspaceId)).map(view);
  }

  async listCredentialCandidates(
    workspaceId: string,
    provider: string,
    model: string,
  ): Promise<ProviderCredentialCandidate[]> {
    return (await this.repository.listProviderCredentials(workspaceId))
      .filter((credential) => this.isEligibleCredential(credential, provider, model))
      .sort((left, right) => (
        right.priority - left.priority
        || left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id)
      ))
        .map((credential) => ({ id: credential.id, revision: credential.ciphertext }));
  }

  async withCredentialCandidate<T>(
    workspaceId: string,
    provider: string,
    model: string,
    candidate: ProviderCredentialCandidate,
    operation: (secret: string, credentialId: string) => Promise<T>,
  ): Promise<T> {
    const credential = await this.repository.findProviderCredential(workspaceId, candidate.id);
    if (
      !credential
      || credential.ciphertext !== candidate.revision
      || !this.isEligibleCredential(credential, provider, model)
    ) {
      throw new GatewayError(503, "api_error", "provider_credential_unavailable", "The provider credential is no longer eligible for this model.");
    }

    let secret: string;
    try {
      secret = await this.cipher.decrypt(
        encryptedFromRecord(credential),
        context(workspaceId, credential.id, credential.provider),
      );
    } catch {
      throw new GatewayError(503, "api_error", "credential_decryption_failed", "WAN Router could not decrypt the provider credential.");
    }
    try {
      return await operation(secret, credential.id);
    } finally {
      secret = "";
    }
  }

  async markCredentialInvalid(workspaceId: string, candidate: ProviderCredentialCandidate): Promise<void> {
    await this.repository.setProviderCredentialVerification(workspaceId, candidate.id, {
      status: "invalid",
      verifiedAt: new Date(),
      error: "Provider rejected the credential during inference.",
      expectedCiphertext: candidate.revision,
    });
  }

  async withCredential<T>(
    workspaceId: string,
    provider: string,
    model: string,
    operation: (secret: string, credentialId: string) => Promise<T>,
  ): Promise<T> {
    const [candidate] = await this.listCredentialCandidates(workspaceId, provider, model);
    if (!candidate) {
      throw new GatewayError(503, "api_error", "provider_credential_unavailable", "No active provider credential is available for this model.");
    }
    return this.withCredentialCandidate(workspaceId, provider, model, candidate, operation);
  }

  async update(workspaceId: string, id: string, input: unknown): Promise<ProviderCredentialView> {
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw parseError(parsed.error);
    const current = await this.repository.findProviderCredential(workspaceId, id);
    if (!current) throw new GatewayError(404, "invalid_request_error", "provider_credential_not_found", "Provider credential was not found.");
    if (parsed.data.secret !== undefined || parsed.data.status === "active") {
      this.requireProviderEnabled(current.provider);
    }

    const patch: UpdateProviderCredentialRecord = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.modelFilters !== undefined ? { modelFilters: [...new Set(parsed.data.modelFilters)] } : {}),
      ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    };
    if (parsed.data.secret !== undefined) {
      const encrypted = await this.cipher.encrypt(parsed.data.secret, context(workspaceId, id, current.provider));
      Object.assign(patch, encryptedPatch(encrypted), {
        maskedValue: maskSecret(parsed.data.secret),
        rotatedAt: new Date(),
        status: "active" as const,
      });
    }

    const updated = await this.repository.updateProviderCredential(workspaceId, id, patch);
    if (!updated) throw new GatewayError(404, "invalid_request_error", "provider_credential_not_found", "Provider credential was not found.");
    return view(updated);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    if (!await this.repository.deleteProviderCredential(workspaceId, id)) {
      throw new GatewayError(404, "invalid_request_error", "provider_credential_not_found", "Provider credential was not found.");
    }
  }

  async verify(workspaceId: string, id: string, signal: AbortSignal): Promise<ProviderCredentialView> {
    const current = await this.repository.findProviderCredential(workspaceId, id);
    if (!current) throw new GatewayError(404, "invalid_request_error", "provider_credential_not_found", "Provider credential was not found.");
    this.requireProviderEnabled(current.provider);
    const verifier = this.verifiers.get(current.provider);
    if (!verifier) {
      throw new GatewayError(400, "invalid_request_error", "provider_verification_unavailable", `Verification is unavailable for ${current.provider}.`);
    }

    let secret: string;
    try {
      secret = await this.cipher.decrypt(encryptedFromRecord(current), context(workspaceId, id, current.provider));
    } catch {
      throw new GatewayError(503, "api_error", "credential_decryption_failed", "WAN Router could not decrypt the provider credential.");
    }

    let result;
    try {
      result = await verifier.verify(secret, signal);
    } finally {
      secret = "";
    }
    const updated = await this.repository.setProviderCredentialVerification(workspaceId, id, {
      status: result.ok ? "active" : "invalid",
      verifiedAt: new Date(),
      error: result.ok ? null : "Provider rejected the credential.",
      expectedCiphertext: current.ciphertext,
    });
    if (!updated) throw new GatewayError(409, "conflict_error", "credential_state_changed", "Provider credential changed during verification.");
    return view(updated);
  }

  private isEligibleCredential(
    credential: ProviderCredentialRecord,
    provider: string,
    model: string,
  ): boolean {
    return this.enabledProviderSet.has(provider)
      && credential.provider === provider
      && credential.status === "active"
      && (!credential.modelFilters.length || credential.modelFilters.includes(model));
  }

  private requireProviderEnabled(provider: string): void {
    if (!this.enabledProviderSet.has(provider)) {
      throw new GatewayError(
        403,
        "permission_error",
        "provider_not_enabled",
        "This direct provider is not enabled for the current WAN Router runtime.",
      );
    }
  }
}