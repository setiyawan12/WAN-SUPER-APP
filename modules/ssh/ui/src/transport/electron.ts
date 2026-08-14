import { api } from "../api";
import type { RemoteTerminalTransport, SshTransportEvent } from "./contract";

export class ElectronRemoteTerminalTransport implements RemoteTerminalTransport {
  readonly capabilities = {
    runtime: "electron" as const,
    remoteTerminal: true,
    hostProfiles: true,
    localShell: true,
    sftp: true,
    tunnels: true,
    recording: true,
    biometric: true,
    openSshImport: true,
    firebaseSync: true
  };

  health() {
    return Promise.resolve({ ok: true, version: "desktop", protocolVersion: 1 as const });
  }

  open(input: Record<string, unknown>) {
    return api.session.open(input);
  }

  write(sessionId: string, data: string) {
    api.session.write(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number) {
    api.session.resize(sessionId, cols, rows);
  }

  answerHostKey(sessionId: string, accept: boolean) {
    api.session.answerHostKey(sessionId, accept);
  }

  answerAuthPrompt(sessionId: string, answers: string[]) {
    api.session.answerAuthPrompt(sessionId, answers);
  }

  async close(sessionId: string) {
    await api.session.close(sessionId);
  }

  onEvent(listener: (event: SshTransportEvent) => void) {
    const unsubscribe = [
      api.on.termOutput((payload: Omit<Extract<SshTransportEvent, { type: "session.output" }>, "type">) => listener({ type: "session.output", ...payload })),
      api.on.termExit((payload: Omit<Extract<SshTransportEvent, { type: "session.exit" }>, "type">) => listener({ type: "session.exit", ...payload })),
      api.on.sessionState((payload: Omit<Extract<SshTransportEvent, { type: "session.state" }>, "type">) => listener({ type: "session.state", ...payload })),
      api.on.hostKeyPrompt((payload: Omit<Extract<SshTransportEvent, { type: "hostkey.prompt" }>, "type">) => listener({ type: "hostkey.prompt", ...payload })),
      api.on.authPrompt((payload: Omit<Extract<SshTransportEvent, { type: "auth.prompt" }>, "type">) => listener({ type: "auth.prompt", ...payload }))
    ];
    return () => unsubscribe.forEach((off) => off());
  }

  dispose() {}
}