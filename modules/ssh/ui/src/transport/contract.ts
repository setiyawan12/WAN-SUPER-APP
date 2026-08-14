export type SshRuntime = "electron" | "web-local" | "web-cloud" | "mock";

export interface SshRuntimeCapabilities {
  runtime: SshRuntime;
  remoteTerminal: boolean;
  hostProfiles: boolean;
  localShell: boolean;
  sftp: boolean;
  tunnels: boolean;
  recording: boolean;
  biometric: boolean;
  openSshImport: boolean;
  firebaseSync: boolean;
}

export type SshTransportEvent =
  | { type: "session.state"; sessionId: string; state: string; reason?: string; message?: string }
  | { type: "session.output"; sessionId: string; data: string }
  | { type: "session.exit"; sessionId: string; code: number; reason: string; message?: string }
  | {
      type: "hostkey.prompt";
      sessionId: string;
      kind: "unknown" | "changed";
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
      previousFingerprint?: string;
    }
  | { type: "auth.prompt"; sessionId: string; prompts: Array<{ prompt: string; echo: boolean }> };

export type WebSessionOpenInput = {
  target: { host: string; port: number; username: string };
  terminal: { cols: number; rows: number; term: string };
  authentication:
    | {
        method: "privateKey";
        privateKey: string;
        passphrase?: string;
      }
    | {
        method: "password";
        password: string;
      };
  expectedHostKeyFingerprint?: string;
};

export interface RemoteTerminalTransport {
  readonly capabilities: SshRuntimeCapabilities;
  health(): Promise<{ ok: boolean; version: string; protocolVersion: 1 }>;
  open(input: WebSessionOpenInput | Record<string, unknown>): Promise<{ sessionId: string }>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  answerHostKey(sessionId: string, accept: boolean): void;
  answerAuthPrompt(sessionId: string, answers: string[]): void;
  close(sessionId: string): Promise<void>;
  onEvent(listener: (event: SshTransportEvent) => void): () => void;
  dispose(): void;
}