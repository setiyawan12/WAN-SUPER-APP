import { GatewayError } from "../errors.js";

export type CredentialVerificationResult =
  | { ok: true }
  | { ok: false; code: "credential_rejected" };

export interface ProviderCredentialVerifier {
  verify(secret: string, signal: AbortSignal): Promise<CredentialVerificationResult>;
}

export class ProviderVerifierRegistry {
  constructor(private readonly verifiers: ReadonlyMap<string, ProviderCredentialVerifier>) {}

  get(provider: string): ProviderCredentialVerifier | undefined {
    return this.verifiers.get(provider);
  }

  providers(): string[] {
    return [...this.verifiers.keys()].sort();
  }
}

export class MockProviderCredentialVerifier implements ProviderCredentialVerifier {
  async verify(secret: string, signal: AbortSignal): Promise<CredentialVerificationResult> {
    if (signal.aborted) {
      throw new GatewayError(499, "request_error", "request_cancelled", "The client cancelled the request.");
    }
    await Promise.resolve();
    return secret.startsWith("mock_provider_")
      ? { ok: true }
      : { ok: false, code: "credential_rejected" };
  }
}