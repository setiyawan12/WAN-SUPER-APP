import { useEffect, useMemo, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, File, Folder, FolderPlus, PenLine, Play, Plus, RefreshCw, Route, SquareTerminal, Trash2, X } from "lucide-react";
import { api } from "./api";
import type { Diagnostics, Host, RemoteEntry, Session, Snippet, TransferJob, Tunnel } from "./types";
import { EnvironmentBadge, Field, formatBytes, formatRelativeTime, IconButton, Segmented, StatusDot, useConfirm } from "./ui";

type View = "files" | "tunnels" | "host" | "snippets";

type Props = {
  activeSession: Session | null;
  selectedHost: Host | null;
  snippets: Snippet[];
  transfers: TransferJob[];
  tunnels: Tunnel[];
  view: View;
  onViewChange: (view: View) => void;
  onEditHost: (host: Host) => void;
  onRunSnippet: (snippetId: string) => void;
  onSaveSnippet: (input: any) => Promise<void>;
  onDeleteSnippet: (id: string) => Promise<void>;
  onTunnelStart: (input: any) => Promise<void>;
  onTunnelStop: (id: string) => Promise<void>;
  onCancelTransfer: (id: string) => Promise<void>;
  onRetryTransfer: (id: string) => Promise<void>;
  onToast: (message: string, tone?: "default" | "danger") => void;
};

function FilesView({ session, transfers, onCancelTransfer, onRetryTransfer, onToast }: { session: Session | null; transfers: TransferJob[]; onCancelTransfer: (id: string) => Promise<void>; onRetryTransfer: (id: string) => Promise<void>; onToast: Props["onToast"] }) {
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const confirm = useConfirm();
  const sessionId = session?.local ? null : session?.sessionId ?? null;

  const load = async (nextPath = path) => {
    if (!sessionId || session?.status !== "connected") return;
    setLoading(true);
    setError(null);
    try {
      const rows = await api.transfer.list({ sessionId, path: nextPath });
      setEntries(rows);
      setPath(nextPath);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionId || session?.status !== "connected") return;
    void api.transfer.home(sessionId).then((home: string) => load(home)).catch(() => load("/"));
  }, [sessionId, session?.status]);

  if (!session || session.local) return <div className="inspector-empty"><Folder size={26} /><span>SFTP tersedia pada sesi SSH.</span></div>;
  if (session.status !== "connected") return <div className="inspector-empty"><StatusDot state={session.status} /><span>Sesi belum terhubung.</span></div>;

  const parent = path === "/" ? "/" : path.split("/").slice(0, -1).join("/") || "/";
  const jobs = transfers.filter((job) => job.sessionId === session.sessionId);
  return (
    <div
      className={`files-view ${dragging ? "dragging" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={async (event) => {
        event.preventDefault();
        setDragging(false);
        if (!event.dataTransfer.files.length) return;
        try {
          await api.transfer.uploadDropped(session.sessionId, path, event.dataTransfer.files, true);
          onToast(`${event.dataTransfer.files.length} file queued`);
        } catch (uploadError) {
          onToast(uploadError instanceof Error ? uploadError.message : String(uploadError), "danger");
        }
      }}
    >
      {dragging && <div className="drop-overlay"><ArrowUpFromLine size={22} /><strong>Drop files to upload</strong><span>{path}</span></div>}
      <div className="inspector-toolbar">
        <IconButton label="Folder atas" onClick={() => void load(parent)} disabled={path === "/"}><ChevronRight size={15} className="rotate-up" /></IconButton>
        <button className="path-button" onClick={() => { const next = window.prompt("Remote path", path); if (next) void load(next); }}>{path}</button>
        <IconButton label="Refresh" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /></IconButton>
        <IconButton label="Folder baru" onClick={async () => { const name = window.prompt("Nama folder"); if (!name) return; await api.transfer.mkdir({ sessionId, path: `${path.replace(/\/$/, "")}/${name}` }); await load(); }}><FolderPlus size={15} /></IconButton>
        <IconButton label="Upload" onClick={async () => { await api.transfer.upload({ sessionId, remoteDirectory: path, resume: true }); onToast("Transfer ditambahkan ke antrean"); }}><ArrowUpFromLine size={15} /></IconButton>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="file-list" aria-busy={loading}>
        {entries.map((entry) => (
          <div className="file-row" key={entry.path} onDoubleClick={() => entry.type === "directory" && void load(entry.path)}>
            {entry.type === "directory" ? <Folder size={15} /> : <File size={15} />}
            <button className="file-name" onClick={() => entry.type === "directory" && void load(entry.path)}>{entry.name}</button>
            <span>{entry.type === "file" ? formatBytes(entry.size) : ""}</span>
            <span>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleDateString() : ""}</span>
            {entry.type === "file" && <IconButton className="row-action" label="Download" onClick={() => void api.transfer.download({ sessionId, remotePath: entry.path, resume: true })}><ArrowDownToLine size={14} /></IconButton>}
            <IconButton className="row-action" label="Ganti nama" onClick={async () => {
              const next = window.prompt(`Ganti nama "${entry.name}"`, entry.name);
              if (!next || next === entry.name) return;
              if (next.includes("/")) { onToast("Nama tidak boleh mengandung '/'", "danger"); return; }
              try {
                await api.transfer.rename({ sessionId, from: entry.path, to: `${path.replace(/\/$/, "")}/${next}` });
                await load();
              } catch (renameError) {
                onToast(renameError instanceof Error ? renameError.message : String(renameError), "danger");
              }
            }}><PenLine size={14} /></IconButton>
            <IconButton className="row-action danger" label="Hapus" onClick={async () => { if (!await confirm({ title: `Hapus ${entry.name}?`, message: entry.type === "directory" ? "Folder dan seluruh isinya akan dihapus." : "File akan dihapus permanen.", confirmLabel: "Hapus", tone: "danger" })) return; await api.transfer.remove({ sessionId, path: entry.path, directory: entry.type === "directory" }); await load(); }}><Trash2 size={14} /></IconButton>
          </div>
        ))}
        {!loading && entries.length === 0 && <div className="empty-list">Folder kosong</div>}
      </div>
      {jobs.length > 0 && (
        <div className="transfer-queue">
          <div className="subsection-title">Transfers <span>{jobs.length}</span></div>
          {jobs.slice(-5).map((job) => {
            const progress = job.total ? Math.min(100, job.transferred / job.total * 100) : 0;
            return (
              <div className="transfer-row" key={job.id}>
                <StatusDot state={job.state} />
                <span className="transfer-name">{job.direction === "upload" ? job.source.split("/").at(-1) : job.destination.split("/").at(-1)}</span>
                <span>{Math.round(progress)}%</span>
                <div className="progress"><span style={{ width: `${progress}%` }} /></div>
                {(job.state === "queued" || job.state === "running" || job.state === "paused") && <IconButton label="Batalkan" onClick={() => void onCancelTransfer(job.id)}><X size={13} /></IconButton>}
                {(job.state === "failed" || job.state === "canceled") && <IconButton label="Coba lagi" onClick={() => void onRetryTransfer(job.id)}><RefreshCw size={13} /></IconButton>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TunnelsView({ session, tunnels, onStart, onStop }: { session: Session | null; tunnels: Tunnel[]; onStart: Props["onTunnelStart"]; onStop: Props["onTunnelStop"] }) {
  const [kind, setKind] = useState<"local" | "remote" | "dynamic">("local");
  const [bindPort, setBindPort] = useState("8080");
  const [targetHost, setTargetHost] = useState("127.0.0.1");
  const [targetPort, setTargetPort] = useState("80");
  const [busy, setBusy] = useState(false);
  if (!session || session.local) return <div className="inspector-empty"><Route size={26} /><span>Forwarding tersedia pada sesi SSH.</span></div>;
  const sessionTunnels = tunnels.filter((tunnel) => tunnel.sessionId === session.sessionId);
  const start = async () => {
    setBusy(true);
    try {
      await onStart({
        sessionId: session.sessionId,
        kind,
        bindAddress: "127.0.0.1",
        bindPort: Number(bindPort) || 0,
        ...(kind === "dynamic" ? {} : { targetHost, targetPort: Number(targetPort) })
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tunnels-view">
      <div className="tunnel-form">
        <Segmented value={kind} ariaLabel="Tipe forwarding" onChange={setKind} options={[{ value: "local", label: "Local" }, { value: "remote", label: "Remote" }, { value: "dynamic", label: "SOCKS5" }]} />
        <div className="form-grid compact-grid">
          <Field label="Bind port"><input type="number" min="0" max="65535" value={bindPort} onChange={(event) => setBindPort(event.target.value)} /></Field>
          {kind !== "dynamic" && <>
            <Field label="Target"><input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} /></Field>
            <Field label="Port"><input type="number" min="1" max="65535" value={targetPort} onChange={(event) => setTargetPort(event.target.value)} /></Field>
          </>}
        </div>
        <button className="button primary" disabled={busy || session.status !== "connected"} onClick={() => void start()}><Plus size={15} /> Start</button>
      </div>
      <div className="tunnel-list">
        {sessionTunnels.map((tunnel) => (
          <div className="tunnel-row" key={tunnel.id}>
            <StatusDot state={tunnel.state} />
            <span className="tunnel-kind">{tunnel.kind.toUpperCase()}</span>
            <span className="tunnel-route">{tunnel.bindAddress}:{tunnel.bindPort}{tunnel.targetHost ? ` → ${tunnel.targetHost}:${tunnel.targetPort}` : ""}</span>
            <IconButton label="Stop" onClick={() => void onStop(tunnel.id)}><X size={14} /></IconButton>
          </div>
        ))}
        {!sessionTunnels.length && <div className="empty-list">Tidak ada forwarding aktif</div>}
      </div>
    </div>
  );
}

function HostView({ host, onEdit, onToast }: { host: Host | null; onEdit: (host: Host) => void; onToast: Props["onToast"] }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  if (!host) return <div className="inspector-empty"><SquareTerminal size={26} /><span>Pilih host untuk melihat detail.</span></div>;
  const run = async () => {
    setBusy(true);
    try {
      setDiagnostics(await api.diagnostics.run(host.id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="host-detail-view">
      <div className="host-detail-heading">
        <div>
          <div className="host-detail-title">{host.label} <EnvironmentBadge environment={host.environment} /></div>
          <div className="muted-copy">{host.effectiveUsername ? `${host.effectiveUsername}@` : ""}{host.address}:{host.effectivePort ?? 22}</div>
        </div>
        <button className="button" onClick={() => onEdit(host)}>Edit</button>
      </div>
      <dl className="detail-list">
        <div><dt>Workspace</dt><dd>{host.vaultId === "personal" ? "Cloud" : "Local"}</dd></div>
        <div><dt>Group</dt><dd>{host.groupPath?.join(" / ") || "Ungrouped"}</dd></div>
        <div><dt>Authentication</dt><dd>{host.hasCredential ? "Configured" : "Not configured"}</dd></div>
        <div><dt>Jump host</dt><dd>{host.jumpHostId ? "Configured" : "Direct"}</dd></div>
        <div><dt>Reconnect</dt><dd>{host.autoReconnect ? `${host.reconnectLimit} attempts` : "Disabled"}</dd></div>
        <div><dt>Last connected</dt><dd>{formatRelativeTime(host.lastConnectedAt)}</dd></div>
      </dl>
      <button className="button primary full" disabled={busy} onClick={() => void run()}><RefreshCw size={15} className={busy ? "spin" : ""} /> Diagnostics</button>
      {diagnostics && (
        <div className="diagnostic-list">
          {diagnostics.phases.map((phase) => (
            <div className="diagnostic-row" key={phase.name}>
              <StatusDot state={phase.ok ? "connected" : "error"} />
              <span>{phase.name.toUpperCase()}</span>
              <strong>{phase.durationMs} ms</strong>
              <small>{phase.detail}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SnippetsView({ session, snippets, onRun, onSave, onDelete }: { session: Session | null; snippets: Snippet[]; onRun: Props["onRunSnippet"]; onSave: Props["onSaveSnippet"]; onDelete: Props["onDeleteSnippet"] }) {
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [vaultId, setVaultId] = useState<"local" | "personal">("local");
  const reset = () => { setEditing(null); setCreating(false); setLabel(""); setCommand(""); };
  const beginEdit = (snippet: Snippet) => { setEditing(snippet); setCreating(true); setLabel(snippet.label); setCommand(snippet.command); setVaultId(snippet.vaultId); };
  const save = async () => {
    await onSave({ id: editing?.id, label, command, vaultId, tags: editing?.tags ?? [] });
    reset();
  };
  return (
    <div className="snippets-view">
      <div className="inspector-toolbar"><span className="toolbar-title">Snippets</span><IconButton label="Snippet baru" onClick={() => { reset(); setCreating(true); }}><Plus size={15} /></IconButton></div>
      {creating && (
        <div className="snippet-editor">
          <input autoFocus placeholder="Label" value={label} onChange={(event) => setLabel(event.target.value)} />
          <textarea placeholder="Command" value={command} onChange={(event) => setCommand(event.target.value)} />
          <Segmented value={vaultId} ariaLabel="Workspace snippet" onChange={setVaultId} options={[{ value: "local", label: "Local" }, { value: "personal", label: "Cloud" }]} />
          <div className="form-actions"><button className="button" onClick={reset}>Cancel</button><button className="button primary" disabled={!label || !command} onClick={() => void save()}>Save</button></div>
        </div>
      )}
      <div className="snippet-list">
        {snippets.map((snippet) => (
          <div className="snippet-row" key={snippet.id} onDoubleClick={() => session && onRun(snippet.id)}>
            <span className="snippet-icon"><SquareTerminal size={15} /></span>
            <span className="snippet-copy"><strong>{snippet.label}</strong><code>{snippet.command}</code></span>
            <button className="icon-button" title="Run" aria-label="Run" disabled={!session || session.status !== "connected"} onClick={() => onRun(snippet.id)}><Play size={14} /></button>
            <button className="text-action" onClick={() => beginEdit(snippet)}>Edit</button>
            <IconButton className="danger" label="Hapus" onClick={() => void onDelete(snippet.id)}><Trash2 size={14} /></IconButton>
          </div>
        ))}
        {!snippets.length && !creating && <div className="empty-list">Belum ada snippet</div>}
      </div>
    </div>
  );
}

export function Inspector(props: Props) {
  const tabs = useMemo(() => [
    { id: "files" as const, label: "Files" },
    { id: "tunnels" as const, label: "Tunnels" },
    { id: "host" as const, label: "Host" },
    { id: "snippets" as const, label: "Snippets" }
  ], []);
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        {tabs.map((tab) => <button key={tab.id} aria-selected={props.view === tab.id} onClick={() => props.onViewChange(tab.id)}>{tab.label}</button>)}
      </div>
      <div className="inspector-content">
        {props.view === "files" && <FilesView session={props.activeSession} transfers={props.transfers} onCancelTransfer={props.onCancelTransfer} onRetryTransfer={props.onRetryTransfer} onToast={props.onToast} />}
        {props.view === "tunnels" && <TunnelsView session={props.activeSession} tunnels={props.tunnels} onStart={props.onTunnelStart} onStop={props.onTunnelStop} />}
        {props.view === "host" && <HostView host={props.selectedHost} onEdit={props.onEditHost} onToast={props.onToast} />}
        {props.view === "snippets" && <SnippetsView session={props.activeSession} snippets={props.snippets} onRun={props.onRunSnippet} onSave={props.onSaveSnippet} onDelete={props.onDeleteSnippet} />}
      </div>
    </aside>
  );
}