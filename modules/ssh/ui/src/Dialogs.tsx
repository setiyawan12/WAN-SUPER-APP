import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Check,
  Cloud,
  Copy,
  FileInput,
  Fingerprint,
  FolderPlus,
  KeyRound,
  Laptop,
  LockKeyhole,
  Plus,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  ScrollText,
  Trash2,
  UserRound,
  Wifi,
  WifiOff
} from "lucide-react";
import { api } from "./api";
import type { SshRuntimeCapabilities } from "./transport/contract";
import type { Catalog, Group, Host, Identity, Snippet, SshKey } from "./types";
import { EnvironmentBadge, Field, IconButton, Modal, Segmented, StatusDot, useConfirm } from "./ui";

export function VaultScreen({ state, error, onUnlock, onCreate, onBiometric, accountLabel, onSignOut, cloudOnly = false }: {
  state: "loading" | "locked" | "no-vault";
  error: string | null;
  onUnlock: (password: string) => Promise<void>;
  onCreate: (password: string) => Promise<void>;
  onBiometric: () => Promise<void>;
  accountLabel?: string;
  onSignOut?: () => void;
  cloudOnly?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [biometric, setBiometric] = useState(false);
  const creating = state === "no-vault";

  useEffect(() => {
    void api.vault.biometricAvailable().then(setBiometric).catch(() => setBiometric(false));
  }, []);

  if (state === "loading") {
    return <div className="vault-screen"><div className="vault-loading"><span className="spinner" /> Memuat vault</div></div>;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || (creating && (password.length < 8 || password !== confirmation))) return;
    setBusy(true);
    try {
      if (creating) await onCreate(password);
      else await onUnlock(password);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vault-screen">
      <div className="vault-grid" aria-hidden="true" />
      <form className="vault-panel" onSubmit={submit}>
        <div className="vault-brand"><span>W</span><div><strong>WANN SSH</strong><small>Secure operations workspace</small></div></div>
        <div className="vault-title-block">
          {creating ? <KeyRound size={26} /> : <LockKeyhole size={26} />}
          <h1>{creating ? "Create encrypted vault" : "Unlock workspace"}</h1>
          <p>{creating ? cloudOnly ? "Credentials are encrypted in this browser before syncing to your Cloud workspace." : "Credentials remain encrypted on this device unless you explicitly place an item in Cloud workspace." : "Unlock identities, keys, hosts, and active workspace settings."}</p>
        </div>
        <Field label="Master password">
          <input autoFocus type="password" autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {creating && <Field label="Confirm password"><input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>}
        {creating && password && password.length < 8 && <div className="inline-error">Use at least 8 characters.</div>}
        {creating && confirmation && password !== confirmation && <div className="inline-error">Passwords do not match.</div>}
        {error && <div className="inline-error">{error}</div>}
        <button className="button primary full large" disabled={busy || !password || (creating && (password.length < 8 || password !== confirmation))}>
          {busy ? <span className="spinner" /> : creating ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}
          {creating ? "Create vault" : "Unlock"}
        </button>
        {!creating && biometric && <button className="button full" type="button" onClick={() => void onBiometric()}><Fingerprint size={17} /> Unlock with device security</button>}
        {accountLabel && onSignOut && <div className="vault-account"><span>Signed in as <strong>{accountLabel}</strong></span><button className="text-action" type="button" onClick={onSignOut}>Sign out</button></div>}
        <p className="vault-note"><ShieldCheck size={14} /> Master password is never sent to Firebase and cannot be recovered.</p>
      </form>
    </div>
  );
}

type HostTab = "connection" | "authentication" | "routing" | "advanced";

function isInlineIdentity(identity: Identity): boolean {
  return identity.label === `${identity.username}@inline`;
}

export function HostDialog({ initial, catalog, onClose, onSave, onDelete, cloudOnly = false, agentForwarding: supportsAgentForwarding = true }: {
  initial: Host | null;
  catalog: Catalog;
  onClose: () => void;
  onSave: (input: any) => Promise<string>;
  onDelete: (id: string) => Promise<void>;
  cloudOnly?: boolean;
  agentForwarding?: boolean;
}) {
  const confirm = useConfirm();
  const savedIdentities = catalog.identities.filter((identity) => !isInlineIdentity(identity));
  const initialSavedIdentityId = initial?.identityId && savedIdentities.some((identity) => identity.id === initial.identityId) ? initial.identityId : "";
  const inlineIdentityId = initial?.identityId && !initialSavedIdentityId ? initial.identityId : null;
  const [tab, setTab] = useState<HostTab>("connection");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [savedId, setSavedId] = useState(initial?.id);
  const [port, setPort] = useState(initial ? String(initial.port ?? "") : "22");
  const [vaultId, setVaultId] = useState<"local" | "personal">(cloudOnly ? "personal" : initial?.vaultId ?? "local");
  const [groupId, setGroupId] = useState(initial?.groupId ?? "");
  const [environment, setEnvironment] = useState<Host["environment"]>(initial?.environment ?? "none");
  const [favorite, setFavorite] = useState(initial?.favorite ?? false);
  const [identityId, setIdentityId] = useState(initialSavedIdentityId);
  const [username, setUsername] = useState(initial?.effectiveUsername ?? "");
  const [password, setPassword] = useState("");
  const [keyId, setKeyId] = useState(initial?.keyId ?? "");
  const [jumpHostId, setJumpHostId] = useState(initial?.jumpHostId ?? "");
  const [useLocalAgent, setUseLocalAgent] = useState(initial?.useLocalAgent ?? false);
  const [startupSnippetId, setStartupSnippetId] = useState(initial?.startupSnippetId ?? "");
  const [agentForwarding, setAgentForwarding] = useState(initial?.agentForwarding ?? false);
  const [autoReconnect, setAutoReconnect] = useState(initial?.autoReconnect ?? true);
  const [reconnectLimit, setReconnectLimit] = useState(String(initial?.reconnectLimit ?? 3));
  const [keepAliveInterval, setKeepAliveInterval] = useState(String(initial?.keepAliveInterval ?? 30));
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const tabs: Array<{ id: HostTab; label: string }> = [
    { id: "connection", label: "Connection" },
    { id: "authentication", label: "Authentication" },
    { id: "routing", label: "Routing" },
    { id: "advanced", label: "Advanced" }
  ];

  const payload = () => ({
    id: savedId,
    vaultId,
    label,
    address,
    port: port.trim() ? Number(port) : null,
    groupId: groupId || null,
    protocol: "ssh",
    identityId: identityId || inlineIdentityId,
    username: identityId ? undefined : username || undefined,
    password: identityId ? undefined : password || undefined,
    keyId: keyId || null,
    jumpHostId: jumpHostId || null,
    startupSnippetId: startupSnippetId || null,
    useLocalAgent,
    tags: tags.split(",").map((value) => value.trim()).filter(Boolean),
    environment,
    favorite,
    agentForwarding,
    autoReconnect,
    reconnectLimit: Number(reconnectLimit) || 0,
    keepAliveInterval: Number(keepAliveInterval) || 0
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const id = await onSave(payload());
      setSavedId(id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (!initial) return;
    try {
      const result = await api.hosts.revealPassword({ id: initial.id, biometric: true });
      if (result.password) {
        setPassword(result.password);
        setShowPassword(true);
        return;
      }
    } catch {
    }
    const masterPassword = window.prompt("Enter master password to reveal this credential");
    if (!masterPassword) return;
    const result = await api.hosts.revealPassword({ id: initial.id, password: masterPassword });
    setPassword(result.password ?? "");
    setShowPassword(true);
  };

  const test = async () => {
    setBusy(true);
    setTestResult("Saving and testing...");
    try {
      const id = await onSave(payload());
      setSavedId(id);
      const result = await api.hosts.testConnection(id);
      setTestResult(result.ok ? `Connected in ${result.latencyMs} ms` : result.error);
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Edit ${initial.label}` : "New SSH host"} onClose={onClose} width={720} footer={<>
      {initial && <button className="button danger-text" onClick={async () => { if (!await confirm({ title: `Delete ${initial.label}?`, message: "This host profile will be permanently removed.", confirmLabel: "Delete", tone: "danger" })) return; await onDelete(initial.id); onClose(); }}><Trash2 size={15} /> Delete</button>}
      <span className="modal-spacer" />
      {testResult && <span className="test-result">{testResult}</span>}
      <button className="button" disabled={busy || !label || !address} onClick={() => void test()}><Wifi size={15} /> Test</button>
      <button className="button primary" disabled={busy || !label || !address} form="host-form" type="submit">{busy ? <span className="spinner" /> : <Check size={15} />} Save</button>
    </>}>
      <form id="host-form" onSubmit={submit}>
        <nav className="modal-tabs">{tabs.map((item) => <button type="button" key={item.id} aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
        {tab === "connection" && <div className="form-grid">
          <Field label="Label"><input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} required /></Field>
          <Field label="Environment"><Segmented value={environment} ariaLabel="Environment" onChange={setEnvironment} options={[{ value: "none", label: "None" }, { value: "prod", label: "PROD" }, { value: "staging", label: "STG" }, { value: "dev", label: "DEV" }]} /></Field>
          <Field label="Address"><input value={address} onChange={(event) => setAddress(event.target.value)} required placeholder="host.example.com or 10.0.0.8" /></Field>
          <Field label="Port" hint={groupId ? "Leave blank to inherit the group port." : undefined}><input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} placeholder={groupId ? "Inherited" : "22"} /></Field>
          <Field label="Workspace" hint={cloudOnly ? "Encrypted cloud workspace" : initial ? "Workspace cannot be changed after creation." : "Cloud items are encrypted before sync."}>{cloudOnly ? <div className="workspace-fixed"><Cloud size={15} /> Cloud</div> : <Segmented value={vaultId} ariaLabel="Workspace" onChange={(value) => !initial && setVaultId(value)} options={[{ value: "local", label: "Local" }, { value: "personal", label: "Cloud" }]} />}</Field>
          <Field label="Group"><select value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">Ungrouped</option>{catalog.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field>
          <label className="toggle-row"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /><span><strong>Favorite</strong><small>Pin this host above groups.</small></span></label>
        </div>}
        {tab === "authentication" && <div className="form-grid">
          <Field label="Saved identity" hint="Identity can be reused across multiple hosts."><select value={identityId} onChange={(event) => setIdentityId(event.target.value)}><option value="">Inline credential</option>{savedIdentities.map((identity) => <option key={identity.id} value={identity.id}>{identity.label} ({identity.username})</option>)}</select></Field>
          <Field label="SSH key"><select value={keyId} onChange={(event) => setKeyId(event.target.value)}><option value="">No explicit key</option>{catalog.keys.map((key) => <option key={key.id} value={key.id}>{key.label} ({key.algorithm})</option>)}</select></Field>
          {!identityId && <>
            <Field label="Username"><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="root" /></Field>
            <Field label="Password" hint={initial && !password ? "Stored credential remains unchanged until you enter a new password." : undefined}>
              <div className="input-action"><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" className="text-action" onClick={() => initial && !password ? void reveal() : setShowPassword((value) => !value)}>{initial && !password ? "Reveal" : showPassword ? "Hide" : "Show"}</button></div>
            </Field>
          </>}
        </div>}
        {tab === "routing" && <div className="form-grid">
          <Field label="Jump host" hint="Chains of up to five bastions are supported."><select value={jumpHostId} onChange={(event) => setJumpHostId(event.target.value)}><option value="">Direct connection</option>{catalog.hosts.filter((host) => host.id !== initial?.id).map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select></Field>
          <Field label="Keepalive seconds"><input type="number" min="0" max="3600" value={keepAliveInterval} onChange={(event) => setKeepAliveInterval(event.target.value)} /></Field>
          <label className="toggle-row"><input type="checkbox" checked={autoReconnect} onChange={(event) => setAutoReconnect(event.target.checked)} /><span><strong>Automatic reconnect</strong><small>Retry with bounded exponential backoff.</small></span></label>
          {autoReconnect && <Field label="Reconnect attempts"><input type="number" min="0" max="10" value={reconnectLimit} onChange={(event) => setReconnectLimit(event.target.value)} /></Field>}
          {supportsAgentForwarding && <label className="toggle-row"><input type="checkbox" checked={agentForwarding} onChange={(event) => setAgentForwarding(event.target.checked)} /><span><strong>Agent forwarding</strong><small>Enable only for servers you trust.</small></span></label>}
          {cloudOnly && <label className="toggle-row"><input type="checkbox" checked={useLocalAgent} onChange={(event) => setUseLocalAgent(event.target.checked)} /><span><strong>Route through the local agent</strong><small>The gateway asks your paired machine to open the connection, so VPN-only targets stay reachable. Pair it from the account menu.</small></span></label>}
        </div>}
        {tab === "advanced" && <div className="form-grid single-column">
          <Field label="Startup snippet"><select value={startupSnippetId} onChange={(event) => setStartupSnippetId(event.target.value)}><option value="">None</option>{catalog.snippets.map((snippet) => <option key={snippet.id} value={snippet.id}>{snippet.label}</option>)}</select></Field>
          <Field label="Tags" hint="Comma-separated; tags are included in search."><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="api, customer-a, primary" /></Field>
          <div className="security-note"><ShieldCheck size={17} /><span>Host-key verification is mandatory. Unknown or changed fingerprints require explicit approval before authentication continues.</span></div>
        </div>}
      </form>
    </Modal>
  );
}

type GroupDraft = {
  id?: string;
  name: string;
  parentId: string;
  username: string;
  port: string;
  keyId: string;
  envText: string;
};

function emptyGroupDraft(): GroupDraft {
  return { name: "", parentId: "", username: "", port: "", keyId: "", envText: "" };
}

function draftFromGroup(group: Group): GroupDraft {
  const defaults = (group.defaults ?? {}) as Record<string, any>;
  const envVars = (defaults.envVars ?? {}) as Record<string, string>;
  return {
    id: group.id,
    name: group.name,
    parentId: group.parentId ?? "",
    username: defaults.username ?? "",
    port: defaults.port ? String(defaults.port) : "",
    keyId: defaults.keyId ?? "",
    envText: Object.entries(envVars).map(([key, value]) => `${key}=${value}`).join("\n")
  };
}

function isDescendant(groups: Group[], candidateParentId: string, groupId: string): boolean {
  let current: string | null = candidateParentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === groupId) return true;
    seen.add(current);
    current = groups.find((group) => group.id === current)?.parentId ?? null;
  }
  return false;
}

export function GroupDialog({ groups, keys, onClose, onSave, onDelete, onToast, cloudOnly = false }: {
  groups: Group[];
  keys: SshKey[];
  onClose: () => void;
  onSave: (input: any) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToast: (message: string, tone?: "default" | "danger") => void;
  cloudOnly?: boolean;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<GroupDraft | null>(() => groups.length ? null : emptyGroupDraft());

  const parseEnv = (): Record<string, string> | null => {
    if (!draft) return null;
    const envVars: Record<string, string> = {};
    for (const line of draft.envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) { onToast(`Baris env tidak valid: "${trimmed}"`, "danger"); return null; }
      envVars[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
    return envVars;
  };

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    if (draft.id && draft.parentId && isDescendant(groups, draft.parentId, draft.id)) {
      onToast("Parent tidak boleh membentuk siklus.", "danger");
      return;
    }
    const envVars = parseEnv();
    if (!envVars) return;
    const defaults: Record<string, any> = {};
    if (draft.username.trim()) defaults.username = draft.username.trim();
    if (draft.port.trim()) defaults.port = Number(draft.port);
    if (draft.keyId) defaults.keyId = draft.keyId;
    if (Object.keys(envVars).length) defaults.envVars = envVars;
    await onSave({ id: draft.id, name: draft.name.trim(), parentId: draft.parentId || null, defaults, ...(cloudOnly ? { vaultId: "personal" } : {}) });
    setDraft(null);
  };

  return <Modal title="Host groups" width={560} onClose={onClose} footer={<><span className="modal-spacer" /><button className="button" onClick={onClose}>Close</button></>}>
    <div className="manager-heading">
      <div><h3>Groups & inheritance</h3><p>Hosts inherit username, port, key, and environment from their group chain.</p></div>
      <button className="button" onClick={() => setDraft(emptyGroupDraft())}><Plus size={15} /> New</button>
    </div>
    {draft && (
      <div className="manager-editor">
        <div className="form-grid">
          <Field label="Name"><input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label="Parent group"><select value={draft.parentId} onChange={(event) => setDraft({ ...draft, parentId: event.target.value })}><option value="">Top level</option>{groups.filter((group) => group.id !== draft.id).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field>
          <Field label="Default username"><input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="Inherited" /></Field>
          <Field label="Default port"><input type="number" min="1" max="65535" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} placeholder="Inherited" /></Field>
          <Field label="Default key"><select value={draft.keyId} onChange={(event) => setDraft({ ...draft, keyId: event.target.value })}><option value="">Inherited</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}</select></Field>
        </div>
        <Field label="Environment variables" hint="One KEY=value per line; applied to the remote shell."><textarea value={draft.envText} onChange={(event) => setDraft({ ...draft, envText: event.target.value })} placeholder={"REGION=ap-southeast-3\nROLE=api"} /></Field>
        <div className="form-actions"><button className="button" onClick={() => setDraft(null)}>Cancel</button><button className="button primary" disabled={!draft.name.trim()} onClick={() => void save()}>Save</button></div>
      </div>
    )}
    <div className="manager-list">
      {groups.map((group) => {
        const defaults = (group.defaults ?? {}) as Record<string, any>;
        const summary = [defaults.username && `user ${defaults.username}`, defaults.port && `port ${defaults.port}`, defaults.keyId && "key", defaults.envVars && `${Object.keys(defaults.envVars).length} env`].filter(Boolean).join(" · ");
        return <div className="manager-row" key={group.id}>
          <FolderPlus size={16} />
          <span className="manager-copy"><strong>{group.name}</strong><small>{group.parentId ? "nested" : "top level"}{summary ? ` · ${summary}` : ""}</small></span>
          <button className="text-action" onClick={() => setDraft(draftFromGroup(group))}>Edit</button>
          <IconButton className="danger" label="Delete" onClick={async () => { if (!await confirm({ title: `Hapus grup "${group.name}"?`, message: "Host di dalam grup tidak ikut terhapus.", confirmLabel: "Hapus", tone: "danger" })) return; await onDelete(group.id); }}><Trash2 size={14} /></IconButton>
        </div>;
      })}
      {!groups.length && !draft && <div className="empty-list">Belum ada grup</div>}
    </div>
  </Modal>;
}

export function HostKeyDialog({ prompt, onAnswer }: { prompt: any; onAnswer: (accept: boolean) => void }) {
  const [verified, setVerified] = useState(false);
  const changed = prompt.kind === "changed";
  return <Modal title={changed ? "Server identity changed" : "Verify new server"} width={560} onClose={() => onAnswer(false)} footer={<><button className="button" onClick={() => onAnswer(false)}>Cancel</button><span className="modal-spacer" /><button className={`button ${changed ? "danger" : "primary"}`} disabled={!verified} onClick={() => onAnswer(true)}>{changed ? "Replace trusted key" : "Trust and continue"}</button></>}>
    <div className={`host-key-warning ${changed ? "changed" : ""}`}>
      {changed ? <ShieldAlert size={25} /> : <ShieldCheck size={25} />}
      <div><strong>{prompt.pattern}</strong><p>{changed ? "A changed fingerprint can indicate a man-in-the-middle attack. Continue only after confirming the key through a separate trusted channel." : "This is the first connection to this server. Compare the fingerprint with the server administrator or console."}</p></div>
    </div>
    {changed && prompt.previous && <div className="fingerprint-block"><span>Previous</span><code>{prompt.previous}</code></div>}
    <div className="fingerprint-block current"><span>Presented now</span><code>{prompt.fingerprint}</code></div>
    <label className="verification-check"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} /><span>I verified this fingerprint using a trusted source.</span></label>
  </Modal>;
}

/**
 * Pairing code memuat refresh token Firebase, jadi ia baru dibuat setelah
 * ditekan eksplisit, tidak pernah ikut tersimpan di state workspace, dan
 * disertai peringatan bahwa nilainya setara sesi login penuh.
 */
export function LocalAgentDialog({ onClose, onCode }: { onClose: () => void; onCode: () => Promise<string> }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    setBusy(true);
    setError("");
    try {
      setCode(await onCode());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(`node wan-ssh-agent.cjs pair ${code}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  return <Modal title="Local agent" width={620} onClose={onClose} footer={<><button className="button" onClick={onClose}>Close</button><span className="modal-spacer" />{code
    ? <button className="button primary" onClick={() => void copy()}>{copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy pair command</>}</button>
    : <button className="button primary" disabled={busy} onClick={() => void reveal()}>{busy ? "Preparing..." : "Show pairing code"}</button>}</>}>
    <div className="security-note local-agent-note"><Laptop size={17} /><span>The gateway can ask a machine you own to open the SSH connection instead of dialling out itself. Run the agent on a machine that is already on the VPN and its targets become reachable — the server never needs VPN access.</span></div>
    <ol className="agent-steps">
      <li>Build the agent once: <code>npm run ssh-agent:bundle</code>, then copy <code>dist/wan-ssh-agent.cjs</code> to the machine that is on the VPN. It needs Node 22+, nothing else.</li>
      <li>Pair it with the command below (the code is valid for this account only).</li>
      <li>Start it: <code>node wan-ssh-agent.cjs run</code></li>
      <li>Tick <strong>Route through the local agent</strong> on the hosts that need it.</li>
    </ol>
    {code
      ? <>
        <div className="fingerprint-block current pair"><span>Pair command</span><code>node wan-ssh-agent.cjs pair {code}</code></div>
        <div className="host-key-warning changed"><ShieldAlert size={25} /><div><strong>Treat this code like a password</strong><p>It carries a Firebase refresh token, so anyone holding it can act as your account. Paste it only into a terminal on your own machine, and run <code>node wan-ssh-agent.cjs unpair</code> on machines you no longer use.</p></div></div>
        <p className="agent-note">Limit what the agent may reach with <code>--allow</code>, for example <code>node wan-ssh-agent.cjs pair &lt;code&gt; --allow 10.8.0.0/24</code>.</p>
      </>
      : <p className="agent-note">{error || "The pairing code is generated on demand and is never stored in this browser."}</p>}
  </Modal>;
}

export function AuthPromptDialog({ prompt, onAnswer }: { prompt: any; onAnswer: (answers: string[] | null) => void }) {
  const [answers, setAnswers] = useState<string[]>(() => prompt.prompts.map(() => ""));
  return <Modal title="Additional authentication" width={460} onClose={() => onAnswer(null)} footer={<><button className="button" onClick={() => onAnswer(null)}>Cancel</button><span className="modal-spacer" /><button className="button primary" onClick={() => onAnswer(answers)}>Continue</button></>}>
    <div className="form-grid single-column">{prompt.prompts.map((label: string, index: number) => <Field key={`${label}-${index}`} label={label}><input autoFocus={index === 0} type={/password|passcode|token/i.test(label) ? "password" : "text"} value={answers[index]} onChange={(event) => setAnswers((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} /></Field>)}</div>
  </Modal>;
}

type SettingsTab = "security" | "identities" | "keys" | "known-hosts" | "openssh" | "audit" | "sync" | "storage";

export function SettingsDialog({ catalog, onCatalogChange, onClose, onToast, capabilities }: { catalog: Catalog; onCatalogChange: () => Promise<void>; onClose: () => void; onToast: (message: string, tone?: "default" | "danger") => void; capabilities?: SshRuntimeCapabilities }) {
  const [tab, setTab] = useState<SettingsTab>("security");
  const [settings, setSettings] = useState<any>(null);
  const [knownHosts, setKnownHosts] = useState<any[]>([]);
  const [sync, setSync] = useState<any>(null);
  const [storage, setStorage] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [identityDraft, setIdentityDraft] = useState<any>(null);
  const [keyMode, setKeyMode] = useState<"generate" | "import" | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [nextSettings, nextKnownHosts, nextAudit, nextSync, nextStorage] = await Promise.all([
      api.vault.settings(), api.knownHosts.list(), api.audit.list(100), api.sync.status(), api.storage.status()
    ]);
    setSettings(nextSettings);
    setKnownHosts(nextKnownHosts);
    setAudit(nextAudit);
    setSync(nextSync);
    setStorage(nextStorage);
  };
  useEffect(() => { void reload(); }, []);
  const settingsTabs: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
    { id: "security", label: "Security", icon: <ShieldCheck size={15} /> },
    { id: "identities", label: "Identities", icon: <UserRound size={15} /> },
    { id: "keys", label: "SSH Keys", icon: <KeyRound size={15} /> },
    { id: "known-hosts", label: "Known Hosts", icon: <Server size={15} /> },
    { id: "openssh", label: "OpenSSH", icon: <FileInput size={15} /> },
    { id: "audit", label: "Audit", icon: <ScrollText size={15} /> },
    { id: "sync", label: "Cloud Sync", icon: <Cloud size={15} /> },
    { id: "storage", label: "Storage", icon: <Laptop size={15} /> }
  ];
  const tabs = settingsTabs.filter((item) => {
    if (item.id === "openssh") return capabilities?.openSshImport !== false;
    if (item.id === "storage") return capabilities?.runtime === undefined || capabilities.runtime === "electron";
    return true;
  });

  return <Modal title="SSH workspace settings" width={820} onClose={onClose}>
    <div className="settings-layout">
      <nav className="settings-nav">{tabs.map((item) => <button key={item.id} aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.icon}{item.label}</button>)}</nav>
      <div className="settings-content">
        {tab === "security" && settings && <SecuritySettings settings={settings} biometric={capabilities?.biometric !== false} onChange={async () => { await reload(); }} onToast={onToast} />}
        {tab === "identities" && <IdentitySettings identities={catalog.identities} keys={catalog.keys} draft={identityDraft} setDraft={setIdentityDraft} cloudOnly={capabilities?.runtime === "web-cloud"} onChange={async () => { await onCatalogChange(); setIdentityDraft(null); }} />}
        {tab === "keys" && <KeySettings keys={catalog.keys} hosts={catalog.hosts} mode={keyMode} setMode={setKeyMode} onChange={onCatalogChange} onToast={onToast} />}
        {tab === "known-hosts" && <div className="manager-list">{knownHosts.map((entry) => <div className="manager-row" key={entry.id}><Server size={16} /><span className="manager-copy"><strong>{entry.hostPattern}</strong><code>{entry.fingerprint}</code><small>{entry.vaultId === "personal" ? "Cloud workspace" : "Local only"}</small></span><IconButton className="danger" label="Revoke trust" onClick={async () => { await api.knownHosts.remove(entry.id); await reload(); }}><Trash2 size={14} /></IconButton></div>)}{!knownHosts.length && <div className="empty-list">No trusted host keys</div>}</div>}
        {tab === "openssh" && <div className="settings-stack"><section className="settings-section"><h3>Import ~/.ssh/config</h3><p className="settings-help">Imports concrete Host entries, user, port, agent forwarding, and ProxyJump chains. Wildcards and Match exec are not executed. Private keys referenced by IdentityFile must be imported separately.</p><button className="button primary" disabled={busy} onClick={async () => { setBusy(true); try { const result = await api.openSsh.importConfig(); if (!result.canceled) { await onCatalogChange(); await reload(); const skipped = result.identityFilesSkipped?.length ? ` · ${result.identityFilesSkipped.length} key path(s) skipped` : ""; onToast(`${result.imported} imported, ${result.updated} updated${skipped}`); } } catch (error) { onToast(error instanceof Error ? error.message : String(error), "danger"); } finally { setBusy(false); } }}><FileInput size={16} /> Import config</button></section></div>}
        {tab === "audit" && <div className="manager-list">{audit.map((entry) => <div className="manager-row" key={entry.id}><ScrollText size={16} /><span className="manager-copy"><strong>{entry.action}</strong><code>{entry.outcome}</code><small>{new Date(entry.timestamp).toLocaleString()} · {Object.keys(entry.detail ?? {}).length ? JSON.stringify(entry.detail) : "No detail"}</small></span></div>)}{!audit.length && <div className="empty-list">No audited actions</div>}</div>}
        {tab === "sync" && <SyncSettings status={sync} busy={busy} setBusy={setBusy} reload={reload} onToast={onToast} />}
        {tab === "storage" && storage && <div className="settings-section"><h3>Local database</h3><dl className="detail-list"><div><dt>Schema</dt><dd>v{storage.schemaVersion}</dd></div><div><dt>Backups</dt><dd>{storage.backups?.length ?? 0} rotating copies</dd></div><div><dt>Recovery</dt><dd>{storage.needed ? "Action recorded" : "Healthy"}</dd></div></dl>{storage.message && <div className="security-note warning"><ShieldAlert size={17} /><span>{storage.message}</span></div>}{storage.needed && <button className="button" onClick={async () => { await api.storage.acknowledgeRecovery(); await reload(); }}>Acknowledge</button>}<p className="settings-help">Database writes are atomic, synced to disk, permissioned to the current user, and backed up before replacement.</p></div>}
      </div>
    </div>
  </Modal>;
}

function SecuritySettings({ settings, biometric, onChange, onToast }: { settings: any; biometric: boolean; onChange: () => Promise<void>; onToast: (message: string, tone?: "default" | "danger") => void }) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  return <div className="settings-stack">
    <section className="settings-section"><h3>Automatic lock</h3><Field label="Idle timeout"><select value={settings.autoLockMs} onChange={async (event) => { await api.vault.setAutoLock(Number(event.target.value)); await onChange(); }}><option value={300000}>5 minutes</option><option value={900000}>15 minutes</option><option value={1800000}>30 minutes</option><option value={3600000}>1 hour</option><option value={14400000}>4 hours</option></select></Field><p className="settings-help">Locking closes SSH, local shell, transfers, tunnels, and active recordings.</p></section>
    {biometric && <section className="settings-section"><h3>Device security</h3><button className="button" disabled={!settings.biometricAvailable} onClick={async () => { try { await api.vault.enableBiometric(); onToast("Device unlock enabled"); } catch (error) { onToast(error instanceof Error ? error.message : String(error), "danger"); } }}><Fingerprint size={16} /> Enable device unlock</button></section>}
    <section className="settings-section"><h3>Change master password</h3><div className="form-grid"><Field label="Current password"><input type="password" value={oldPassword} onChange={(event) => setOldPassword(event.target.value)} /></Field><Field label="New password"><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field></div><button className="button primary" disabled={!oldPassword || newPassword.length < 8} onClick={async () => { await api.vault.changePassword(oldPassword, newPassword); setOldPassword(""); setNewPassword(""); onToast("Master password changed"); }}>Update password</button></section>
  </div>;
}

function IdentitySettings({ identities, keys, draft, setDraft, onChange, cloudOnly }: { identities: Identity[]; keys: SshKey[]; draft: any; setDraft: (value: any) => void; onChange: () => Promise<void>; cloudOnly: boolean }) {
  return <div className="settings-stack"><div className="manager-heading"><div><h3>Reusable identities</h3><p>Username, password, and key references shared by hosts.</p></div><button className="button" onClick={() => setDraft({ label: "", username: "", password: "", keyId: "", vaultId: cloudOnly ? "personal" : "local" })}><Plus size={15} /> New</button></div>{draft && <div className="manager-editor"><div className="form-grid"><Field label="Label"><input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field><Field label="Username"><input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></Field><Field label="Password"><input type="password" value={draft.password ?? ""} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /></Field><Field label="Key"><select value={draft.keyId ?? ""} onChange={(event) => setDraft({ ...draft, keyId: event.target.value || null })}><option value="">No key</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.label}</option>)}</select></Field></div><div className="form-actions"><button className="button" onClick={() => setDraft(null)}>Cancel</button><button className="button primary" disabled={!draft.label || !draft.username} onClick={async () => { await api.identities.save({ ...draft, vaultId: cloudOnly ? "personal" : draft.vaultId }); await onChange(); }}>Save</button></div></div>}<div className="manager-list">{identities.map((identity) => <div className="manager-row" key={identity.id}><UserRound size={16} /><span className="manager-copy"><strong>{identity.label}</strong><small>{identity.username}{identity.hasSecret ? " · password" : ""}{identity.keyId ? " · SSH key" : ""}</small></span><button className="text-action" onClick={() => setDraft({ ...identity, password: "" })}>Edit</button><IconButton className="danger" label="Delete" onClick={async () => { await api.identities.remove(identity.id); await onChange(); }}><Trash2 size={14} /></IconButton></div>)}</div></div>;
}

function KeySettings({ keys, hosts, mode, setMode, onChange, onToast }: { keys: SshKey[]; hosts: Host[]; mode: "generate" | "import" | null; setMode: (value: "generate" | "import" | null) => void; onChange: () => Promise<void>; onToast: (message: string, tone?: "default" | "danger") => void }) {
  const [draft, setDraft] = useState<any>({ label: "", algorithm: "ed25519", passphrase: "", pem: "" });
  const save = async () => { if (mode === "generate") await api.keys.generate({ label: draft.label, algorithm: draft.algorithm, bits: draft.algorithm === "rsa" ? 4096 : undefined, passphrase: draft.passphrase || undefined }); else await api.keys.importPem({ label: draft.label, pem: draft.pem, passphrase: draft.passphrase || undefined }); setMode(null); setDraft({ label: "", algorithm: "ed25519", passphrase: "", pem: "" }); await onChange(); };
  return <div className="settings-stack"><div className="manager-heading"><div><h3>SSH keys</h3><p>Private material remains encrypted inside the vault.</p></div><span className="button-group"><button className="button" onClick={() => setMode("generate")}>Generate</button><button className="button" onClick={() => setMode("import")}>Import</button></span></div>{mode && <div className="manager-editor"><div className="form-grid"><Field label="Label"><input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></Field>{mode === "generate" && <Field label="Algorithm"><select value={draft.algorithm} onChange={(event) => setDraft({ ...draft, algorithm: event.target.value })}><option value="ed25519">Ed25519</option><option value="ecdsa">ECDSA P-256</option><option value="rsa">RSA 4096</option></select></Field>}<Field label="Passphrase"><input type="password" value={draft.passphrase} onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })} /></Field>{mode === "import" && <Field label="Private key"><textarea value={draft.pem} onChange={(event) => setDraft({ ...draft, pem: event.target.value })} /></Field>}</div><div className="form-actions"><button className="button" onClick={() => setMode(null)}>Cancel</button><button className="button primary" disabled={!draft.label || (mode === "import" && !draft.pem)} onClick={() => void save()}>Save</button></div></div>}<div className="manager-list">{keys.map((key) => <div className="manager-row" key={key.id}><KeyRound size={16} /><span className="manager-copy"><strong>{key.label}</strong><code>{key.fingerprintSha256}</code><small>{key.algorithm}{key.bits ? ` ${key.bits}` : ""} · {key.source}</small></span><IconButton label="Copy public key" onClick={async () => { await navigator.clipboard.writeText(await api.keys.exportPublic(key.id)); onToast("Public key copied"); }}><Copy size={14} /></IconButton><select className="inline-select" defaultValue="" onChange={async (event) => { if (!event.target.value) return; await api.keys.pushToHost(key.id, event.target.value); onToast("Public key installed"); event.target.value = ""; }}><option value="">Push to...</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}</select><IconButton className="danger" label="Delete" onClick={async () => { await api.keys.remove(key.id); await onChange(); }}><Trash2 size={14} /></IconButton></div>)}</div></div>;
}

function SyncSettings({ status, busy, setBusy, reload, onToast }: { status: any; busy: boolean; setBusy: (value: boolean) => void; reload: () => Promise<void>; onToast: (message: string, tone?: "default" | "danger") => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  if (!status) return <div className="loading-line"><span className="spinner" /> Loading</div>;
  const action = async (run: () => Promise<unknown>, message: string) => { setBusy(true); try { await run(); await reload(); onToast(message); } catch (error) { onToast(error instanceof Error ? error.message : String(error), "danger"); } finally { setBusy(false); } };
  return <div className="settings-stack"><section className="settings-section"><div className="sync-heading"><StatusDot state={status.state} /><div><h3>{status.configured ? status.user ? "Cloud sync active" : "Cloud sync ready" : "Offline-only mode"}</h3><p>{status.user ?? "No signed-in account"}{status.pending ? ` · ${status.pending} pending` : ""}</p></div></div>{!status.configured && <button className="button" disabled={busy} onClick={() => void action(() => api.sync.importConfig(), "Firebase config imported")}>Import Firebase config</button>}{status.configured && status.user && <div className="button-group"><button className="button" disabled={busy} onClick={() => void action(() => api.sync.now(), "Sync completed")}>Sync now</button><button className="button" disabled={busy} onClick={() => void action(() => api.sync.pushAll(), "Cloud data rebuilt")}>Re-upload all</button><button className="button" disabled={busy} onClick={() => void action(() => api.sync.signOut(), "Signed out")}>Sign out</button></div>}</section>{status.configured && !status.user && <section className="settings-section"><h3>Sign in</h3><div className="form-grid"><Field label="Email"><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field><Field label="Password"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field></div><div className="button-group"><button className="button primary" disabled={busy || !email || !password} onClick={() => void action(() => api.sync.signIn(email, password), "Signed in and synchronized")}>Sign in</button><button className="button" disabled={busy} onClick={() => void action(() => api.sync.signInGoogle(), "Google account connected")}>Continue with Google</button></div></section>}</div>;
}

export function CommandPalette({ commands, onClose }: { commands: Array<{ id: string; label: string; hint?: string; icon: ReactNode; run: () => void; disabled?: boolean }>; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = useMemo(() => commands.filter((command) => `${command.label} ${command.hint ?? ""}`.toLowerCase().includes(query.toLowerCase())), [commands, query]);
  useEffect(() => setActive(0), [query]);
  const execute = (index: number) => { const command = filtered[index]; if (!command || command.disabled) return; command.run(); onClose(); };
  return <div className="palette-backdrop" onMouseDown={onClose}><section className="command-palette" onMouseDown={(event) => event.stopPropagation()}><div className="palette-search"><Search size={17} /><input autoFocus placeholder="Type a command" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(filtered.length - 1, value + 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); } if (event.key === "Enter") execute(active); if (event.key === "Escape") onClose(); }} /><kbd>esc</kbd></div><div className="palette-list">{filtered.map((command, index) => <button key={command.id} className={index === active ? "active" : ""} disabled={command.disabled} onMouseEnter={() => setActive(index)} onClick={() => execute(index)}>{command.icon}<span><strong>{command.label}</strong>{command.hint && <small>{command.hint}</small>}</span></button>)}{!filtered.length && <div className="empty-list">No matching command</div>}</div></section></div>;
}