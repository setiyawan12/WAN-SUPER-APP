import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bot,
  CircleStop,
  Clipboard,
  ClipboardPaste,
  Command,
  Copy,
  FolderOpen,
  KeyRound,
  LockKeyhole,
  PanelRight,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Route,
  Search,
  Server,
  Settings,
  SplitSquareHorizontal,
  SquareTerminal,
  TerminalSquare,
  Trash2,
  WifiOff,
  X
} from "lucide-react";
import { api, isMockApi } from "./api";
import { AuthPromptDialog, CommandPalette, GroupDialog, HostDialog, HostKeyDialog, SettingsDialog, VaultScreen } from "./Dialogs";
import { Inspector } from "./Inspector";
import { ResourceExplorer } from "./ResourceExplorer";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import type { Catalog, Host, Session, TransferJob, Tunnel } from "./types";
import { EnvironmentBadge, IconButton, StatusDot } from "./ui";

type InspectorView = "files" | "tunnels" | "host" | "snippets";
type VaultState = "loading" | "locked" | "no-vault" | "unlocked";

const emptyCatalog: Catalog = { hosts: [], groups: [], identities: [], keys: [], snippets: [] };

function normalizeSessionState(value: string): Session["status"] {
  if (["connecting", "authenticating", "connected", "reconnecting", "disconnected", "error", "closed"].includes(value)) return value as Session["status"];
  return "error";
}

function hostPayload(host: Host, patch: Partial<Host> = {}) {
  const value = { ...host, ...patch };
  return {
    id: value.id,
    vaultId: value.vaultId,
    groupId: value.groupId,
    label: value.label,
    address: value.address,
    port: value.port,
    protocol: "ssh",
    identityId: value.identityId,
    keyId: value.keyId,
    jumpHostId: value.jumpHostId,
    startupSnippetId: value.startupSnippetId,
    tags: value.tags,
    environment: value.environment,
    favorite: value.favorite,
    agentForwarding: value.agentForwarding,
    autoReconnect: value.autoReconnect,
    reconnectLimit: value.reconnectLimit,
    keepAliveInterval: value.keepAliveInterval
  };
}

export default function App() {
  const [vaultState, setVaultState] = useState<VaultState>("loading");
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [tabs, setTabs] = useState<string[]>([]);
  const [primarySessionId, setPrimarySessionId] = useState<string | null>(null);
  const [secondarySessionId, setSecondarySessionId] = useState<string | null>(null);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 980);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [inspectorView, setInspectorView] = useState<InspectorView>("host");
  const [transfers, setTransfers] = useState<TransferJob[]>([]);
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [recording, setRecording] = useState<Record<string, boolean>>({});
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [storageStatus, setStorageStatus] = useState<any>(null);
  const [hostDialog, setHostDialog] = useState<Host | "new" | null>(null);
  const [groupDialog, setGroupDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<any>(null);
  const [authPrompt, setAuthPrompt] = useState<any>(null);
  const [toast, setToast] = useState<{ message: string; tone: "default" | "danger"; id: number } | null>(null);
  const terminalRefs = useRef(new Map<string, TerminalHandle>());
  const mockOpened = useRef(false);

  const showToast = useCallback((message: string, tone: "default" | "danger" = "default") => {
    const id = Date.now();
    setToast({ message, tone, id });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 3600);
  }, []);

  const reloadCatalog = useCallback(async () => {
    const [hosts, groups, identities, keys, snippets] = await Promise.all([
      api.hosts.list(), api.groups.list(), api.identities.list(), api.keys.list(), api.snippets.list()
    ]);
    setCatalog({ hosts, groups, identities, keys, snippets });
    setSelectedHostId((current) => current && hosts.some((host: Host) => host.id === current) ? current : hosts[0]?.id ?? null);
  }, []);

  const reloadOperationalState = useCallback(async () => {
    const [jobs, activeTunnels, sync, storage] = await Promise.all([
      api.transfer.jobs().catch(() => []),
      api.tunnels.list().catch(() => []),
      api.sync.status().catch(() => null),
      api.storage.status().catch(() => null)
    ]);
    setTransfers(jobs);
    setTunnels(activeTunnels);
    setSyncStatus(sync);
    setStorageStatus(storage);
  }, []);

  const unlockComplete = useCallback(async () => {
    setVaultState("unlocked");
    setVaultError(null);
    await Promise.all([reloadCatalog(), reloadOperationalState()]);
  }, [reloadCatalog, reloadOperationalState]);

  useEffect(() => {
    void api.vault.status().then(({ state }: any) => {
      setVaultState(state);
      if (state === "unlocked") void unlockComplete();
    }).catch((error: unknown) => {
      setVaultError(error instanceof Error ? error.message : String(error));
      setVaultState("locked");
    });
  }, [unlockComplete]);

  useEffect(() => {
    const offStore = api.on.storeChanged(() => void reloadCatalog());
    const offVault = api.on.vaultLocked(() => {
      setVaultState("locked");
      setSessions({});
      setTabs([]);
      setPrimarySessionId(null);
      setSecondarySessionId(null);
      setFocusedSessionId(null);
      setTransfers([]);
      setTunnels([]);
      setRecording({});
    });
    const offSession = api.on.sessionState((payload: any) => {
      setSessions((current) => {
        const session = current[payload.sessionId];
        if (!session) return current;
        return {
          ...current,
          [payload.sessionId]: {
            ...session,
            status: normalizeSessionState(payload.state),
            reason: payload.reason,
            message: payload.message
          }
        };
      });
    });
    const offExit = api.on.termExit((payload: any) => {
      setSessions((current) => {
        const session = current[payload.sessionId];
        if (!session) return current;
        return { ...current, [payload.sessionId]: { ...session, status: "disconnected", reason: payload.reason, message: payload.message } };
      });
    });
    const offHostKey = api.on.hostKeyPrompt(setHostKeyPrompt);
    const offAuth = api.on.authPrompt(setAuthPrompt);
    const offTransfer = api.on.transferProgress((payload: TransferJob) => {
      setTransfers((current) => {
        const next = current.filter((job) => job.id !== payload.id);
        return [...next, payload].sort((a, b) => a.id.localeCompare(b.id));
      });
    });
    const offTunnels = api.on.tunnelChanged((payload: Tunnel[]) => {
      if (Array.isArray(payload)) setTunnels(payload);
    });
    const offSync = api.on.syncState((payload: any) => setSyncStatus((current: any) => ({ ...current, ...payload })));
    return () => {
      offStore(); offVault(); offSession(); offExit(); offHostKey(); offAuth(); offTransfer(); offTunnels(); offSync();
    };
  }, [reloadCatalog]);

  const addSession = useCallback((session: Session) => {
    setSessions((current) => ({ ...current, [session.sessionId]: session }));
    setTabs((current) => current.includes(session.sessionId) ? current : [...current, session.sessionId]);
    setPrimarySessionId(session.sessionId);
    setFocusedSessionId(session.sessionId);
  }, []);

  const openHost = useCallback(async (host: Host) => {
    setConnectingHostId(host.id);
    setSelectedHostId(host.id);
    try {
      const result = await api.session.open({ hostId: host.id, cols: 100, rows: 32 });
      addSession({
        sessionId: result.sessionId,
        hostId: host.id,
        label: host.label,
        environment: host.environment,
        status: "connected",
        local: false
      });
      setInspectorView("files");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      setConnectingHostId(null);
    }
  }, [addSession, showToast]);

  const openLocal = useCallback(async () => {
    try {
      const result = await api.session.openLocal({ cols: 100, rows: 32 });
      addSession({ sessionId: result.sessionId, hostId: null, label: "Local shell", environment: "none", status: "connected", local: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "danger");
    }
  }, [addSession, showToast]);

  useEffect(() => {
    if (!isMockApi || mockOpened.current || vaultState !== "unlocked" || !catalog.hosts.length) return;
    mockOpened.current = true;
    void openHost(catalog.hosts[0]);
  }, [catalog.hosts, openHost, vaultState]);

  const closeSession = useCallback(async (sessionId: string) => {
    if (recording[sessionId]) {
      if (window.confirm("Save the active recording before closing this session?")) {
        const result = await api.recording.stop(sessionId);
        if (!result.saved) return;
      } else {
        await api.recording.discard(sessionId);
      }
    }
    await api.session.close(sessionId);
    terminalRefs.current.delete(sessionId);
    setRecording((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    setSessions((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    setTabs((current) => {
      const next = current.filter((id) => id !== sessionId);
      const fallback = next.at(-1) ?? null;
      setPrimarySessionId((value) => value === sessionId ? fallback : value);
      setSecondarySessionId((value) => value === sessionId ? null : value);
      setFocusedSessionId((value) => value === sessionId ? fallback : value);
      return next;
    });
  }, [recording]);

  const selectTab = (sessionId: string) => {
    if (sessionId !== secondarySessionId) setPrimarySessionId(sessionId);
    setFocusedSessionId(sessionId);
  };

  const toggleSplit = () => {
    if (secondarySessionId) {
      setSecondarySessionId(null);
      setFocusedSessionId(primarySessionId);
      return;
    }
    const other = tabs.find((id) => id !== primarySessionId) ?? null;
    if (!other) return;
    setSecondarySessionId(other);
    setFocusedSessionId(primarySessionId);
  };

  const focusedSession = focusedSessionId ? sessions[focusedSessionId] ?? null : null;
  const selectedHost = catalog.hosts.find((host) => host.id === selectedHostId) ?? null;
  const activeTerminal = useCallback(
    () => focusedSessionId ? terminalRefs.current.get(focusedSessionId) : undefined,
    [focusedSessionId]
  );

  const reconnect = async () => {
    if (!focusedSession || focusedSession.local) return;
    const dimensions = activeTerminal()?.dimensions() ?? { cols: 100, rows: 32 };
    try {
      await api.session.reconnect({ sessionId: focusedSession.sessionId, ...dimensions });
      setSessions((current) => ({ ...current, [focusedSession.sessionId]: { ...current[focusedSession.sessionId], status: "connected" } }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "danger");
    }
  };

  const toggleRecording = async () => {
    if (!focusedSession) return;
    if (recording[focusedSession.sessionId]) {
      const result = await api.recording.stop(focusedSession.sessionId);
      if (result.saved) {
        setRecording((current) => ({ ...current, [focusedSession.sessionId]: false }));
        showToast("Recording saved");
      }
      return;
    }
    const dimensions = activeTerminal()?.dimensions() ?? { cols: 100, rows: 32 };
    await api.recording.start({ sessionId: focusedSession.sessionId, ...dimensions, includeInput: false });
    setRecording((current) => ({ ...current, [focusedSession.sessionId]: true }));
    showToast("Recording started; keyboard input is excluded");
  };

  const sendSelectionToChat = async () => {
    if (!focusedSession) return;
    const selection = activeTerminal()?.selection().trim() ?? "";
    if (!selection) return showToast("Select terminal output first", "danger");
    if (!window.confirm(`Add ${Math.min(selection.length, 50_000).toLocaleString()} characters from ${focusedSession.label} to Chat context? Nothing will be sent automatically.`)) return;
    const superApp = (window as unknown as { superApp?: { sendToChat?: (input: any) => Promise<{ ok: boolean; error?: string; truncated?: boolean }> } }).superApp;
    if (!superApp?.sendToChat) {
      await navigator.clipboard.writeText(selection.slice(0, 50_000));
      return showToast("Selection copied; Super App Chat is unavailable in standalone mode");
    }
    const result = await superApp.sendToChat({ label: `SSH: ${focusedSession.label}`, text: selection, source: "ssh" });
    if (!result.ok) showToast(result.error ?? "Unable to open Chat", "danger");
  };

  const saveHost = async (input: any) => {
    const id = await api.hosts.save(input);
    await reloadCatalog();
    setSelectedHostId(id);
    return id;
  };

  const deleteHost = async (id: string) => {
    await api.hosts.remove(id);
    await reloadCatalog();
  };

  const toggleFavorite = async (host: Host) => {
    await api.hosts.save(hostPayload(host, { favorite: !host.favorite }));
    await reloadCatalog();
  };

  const saveSnippet = async (input: any) => { await api.snippets.save(input); await reloadCatalog(); };
  const deleteSnippet = async (id: string) => { await api.snippets.remove(id); await reloadCatalog(); };
  const runSnippet = (snippetId: string) => {
    if (!focusedSession) return;
    void api.snippets.run({ sessionId: focusedSession.sessionId, snippetId, appendNewline: true });
    activeTerminal()?.focus();
  };
  const startTunnel = async (input: any) => { await api.tunnels.start(input); setTunnels(await api.tunnels.list()); };
  const stopTunnel = async (id: string) => { await api.tunnels.stop(id); setTunnels(await api.tunnels.list()); };
  const cancelTransfer = async (id: string) => { await api.transfer.cancel(id); };
  const retryTransfer = async (id: string) => { await api.transfer.retry(id); };

  const commands = useMemo<Array<{ id: string; label: string; hint?: string; icon: ReactNode; run: () => void; disabled?: boolean }>>(() => [
    { id: "new-host", label: "New SSH host", hint: "Create a connection profile", icon: <Plus size={16} />, run: () => setHostDialog("new") },
    { id: "local", label: "Open local shell", hint: "Start a terminal on this device", icon: <SquareTerminal size={16} />, run: () => void openLocal() },
    { id: "connect", label: "Connect selected host", hint: selectedHost?.label, icon: <Play size={16} />, disabled: !selectedHost, run: () => selectedHost && void openHost(selectedHost) },
    { id: "reconnect", label: "Reconnect active session", icon: <RefreshCw size={16} />, disabled: !focusedSession || focusedSession.local || focusedSession.status === "connected", run: () => void reconnect() },
    { id: "files", label: "Open SFTP inspector", icon: <FolderOpen size={16} />, disabled: !focusedSession || focusedSession.local, run: () => { setInspectorOpen(true); setInspectorView("files"); } },
    { id: "tunnels", label: "Open forwarding inspector", icon: <Route size={16} />, disabled: !focusedSession || focusedSession.local, run: () => { setInspectorOpen(true); setInspectorView("tunnels"); } },
    { id: "search", label: "Search terminal output", hint: "Command/Ctrl + F", icon: <Search size={16} />, disabled: !focusedSession, run: () => activeTerminal()?.openSearch() },
    { id: "record", label: recording[focusedSessionId ?? ""] ? "Stop and save recording" : "Start terminal recording", icon: recording[focusedSessionId ?? ""] ? <CircleStop size={16} /> : <Radio size={16} />, disabled: !focusedSession, run: () => void toggleRecording() },
    { id: "ai", label: "Add selection to Chat context", icon: <Bot size={16} />, disabled: !focusedSession, run: () => void sendSelectionToChat() },
    { id: "settings", label: "SSH workspace settings", icon: <Settings size={16} />, run: () => setSettingsOpen(true) },
    { id: "lock", label: "Lock encrypted vault", icon: <LockKeyhole size={16} />, run: () => void api.vault.lock() }
  ], [activeTerminal, focusedSession, focusedSessionId, openHost, openLocal, recording, selectedHost]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && key === "l" && !event.shiftKey) {
        event.preventDefault();
        void api.vault.lock();
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === "f") {
        event.preventDefault();
        toggleSplit();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [primarySessionId, secondarySessionId, tabs]);

  if (vaultState !== "unlocked") {
    return <VaultScreen
      state={vaultState}
      error={vaultError}
      onUnlock={async (password) => { setVaultError(null); try { await api.vault.unlock(password); await unlockComplete(); } catch { setVaultError("Master password is incorrect or this vault cannot be unlocked."); } }}
      onCreate={async (password) => { setVaultError(null); try { await api.vault.create(password); await unlockComplete(); } catch (error) { setVaultError(error instanceof Error ? error.message : String(error)); } }}
      onBiometric={async () => { if (await api.vault.tryBiometricUnlock()) await unlockComplete(); else setVaultError("Device unlock is not configured for this vault."); }}
    />;
  }

  return (
    <div className={`ssh-app ${inspectorOpen ? "with-inspector" : ""}`}>
      <header className="app-titlebar">
        <div className="traffic-space" />
        <button className="titlebar-button mobile-resources" onClick={() => setExplorerOpen(true)}><Server size={15} /> Resources</button>
        {(window as unknown as { superApp?: { showHub?: () => Promise<unknown> } }).superApp?.showHub && <button className="titlebar-button" onClick={() => void (window as unknown as { superApp: { showHub: () => Promise<unknown> } }).superApp.showHub()}><ArrowLeft size={15} /> Hub</button>}
        <div className="product-mark"><TerminalSquare size={17} /><strong>WANN SSH</strong><span>Operations workspace</span></div>
        <button className="command-trigger" onClick={() => setPaletteOpen(true)}><Command size={14} /><span>Command</span><kbd>⌘K</kbd></button>
        <div className="titlebar-spacer" />
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)}><Settings size={16} /></IconButton>
        <button className="titlebar-button" onClick={() => void api.vault.lock()}><LockKeyhole size={15} /> Lock</button>
      </header>

      {storageStatus?.needed && <div className="recovery-banner"><WifiOff size={15} /><span>{storageStatus.message}</span><button onClick={async () => { await api.storage.acknowledgeRecovery(); setStorageStatus({ ...storageStatus, needed: false }); }}>Acknowledge</button></div>}

      <div className="app-workspace">
        {explorerOpen && <button className="drawer-backdrop" aria-label="Close resources" onClick={() => setExplorerOpen(false)} />}
        <div className={`resource-drawer ${explorerOpen ? "open" : ""}`}>
          <ResourceExplorer
            hosts={catalog.hosts}
            groups={catalog.groups}
            selectedHostId={selectedHostId}
            connectingHostId={connectingHostId}
            onSelect={(id) => { setSelectedHostId(id); setInspectorView("host"); setExplorerOpen(false); }}
            onConnect={(host) => { setExplorerOpen(false); void openHost(host); }}
            onNewHost={() => { setExplorerOpen(false); setHostDialog("new"); }}
            onNewGroup={() => { setExplorerOpen(false); setGroupDialog(true); }}
            onOpenLocal={() => { setExplorerOpen(false); void openLocal(); }}
            onSettings={() => { setExplorerOpen(false); setSettingsOpen(true); }}
            onToggleFavorite={(host) => void toggleFavorite(host)}
          />
        </div>

        <main className="terminal-workspace">
          <div className="session-tabs">
            <div className="tab-scroll">
              {tabs.map((id) => {
                const session = sessions[id];
                if (!session) return null;
                const selected = focusedSessionId === id;
                return <button className={`session-tab ${selected ? "active" : ""}`} key={id} onClick={() => selectTab(id)}>
                  <span className={`session-environment ${session.environment}`} />
                  <StatusDot state={session.status} />
                  <span>{session.label}</span>
                  <EnvironmentBadge environment={session.environment} />
                  <span className="tab-close" role="button" aria-label="Close" onClick={(event) => { event.stopPropagation(); void closeSession(id); }}><X size={13} /></span>
                </button>;
              })}
            </div>
            <IconButton label="New local shell" onClick={() => void openLocal()}><Plus size={16} /></IconButton>
          </div>

          <div className="terminal-toolbar">
            <div className="toolbar-session">
              {focusedSession ? <><StatusDot state={focusedSession.status} /><strong>{focusedSession.label}</strong><span>{focusedSession.status}</span></> : <span>No active session</span>}
            </div>
            <div className="toolbar-actions">
              <IconButton label="Search output" disabled={!focusedSession} onClick={() => activeTerminal()?.openSearch()}><Search size={15} /></IconButton>
              <IconButton label="Copy selection" disabled={!focusedSession} onClick={() => void activeTerminal()?.copy()}><Copy size={15} /></IconButton>
              <IconButton label="Paste" disabled={!focusedSession} onClick={() => void activeTerminal()?.paste()}><ClipboardPaste size={15} /></IconButton>
              <IconButton label="Clear terminal" disabled={!focusedSession} onClick={() => activeTerminal()?.clear()}><Trash2 size={15} /></IconButton>
              <span className="toolbar-separator" />
              <IconButton label="Reconnect" disabled={!focusedSession || focusedSession.local || focusedSession.status === "connected"} onClick={() => void reconnect()}><RefreshCw size={15} /></IconButton>
              <IconButton label={secondarySessionId ? "Close split" : "Split terminal"} disabled={tabs.length < 2} onClick={toggleSplit}><SplitSquareHorizontal size={15} /></IconButton>
              <IconButton className={recording[focusedSessionId ?? ""] ? "recording" : ""} label={recording[focusedSessionId ?? ""] ? "Stop and save recording" : "Start recording"} disabled={!focusedSession} onClick={() => void toggleRecording()}>{recording[focusedSessionId ?? ""] ? <CircleStop size={15} /> : <Radio size={15} />}</IconButton>
              <IconButton label="Add selection to Chat" disabled={!focusedSession} onClick={() => void sendSelectionToChat()}><Bot size={15} /></IconButton>
              <span className="toolbar-separator" />
              <IconButton className={inspectorOpen ? "active" : ""} label={inspectorOpen ? "Hide inspector" : "Show inspector"} onClick={() => setInspectorOpen((value) => !value)}><PanelRight size={15} /></IconButton>
            </div>
          </div>

          <div className={`terminal-grid ${secondarySessionId ? "split" : ""}`}>
            {tabs.length === 0 && <div className="workspace-empty"><TerminalSquare size={34} /><strong>Start an operational session</strong><p>Select a host and press Connect, or open a local shell.</p><div><button className="button primary" disabled={!selectedHost} onClick={() => selectedHost && void openHost(selectedHost)}><Play size={15} /> Connect {selectedHost?.label ?? "host"}</button><button className="button" onClick={() => void openLocal()}><SquareTerminal size={15} /> Local shell</button></div></div>}
            {tabs.map((id) => {
              const session = sessions[id];
              if (!session) return null;
              const column = id === primarySessionId ? 1 : id === secondarySessionId ? 2 : null;
              return <div key={id} className={`terminal-surface ${column ? "visible" : "hidden"} ${focusedSessionId === id ? "focused" : ""}`} style={column ? { gridColumn: column } : undefined} onMouseDown={() => setFocusedSessionId(id)}>
                <TerminalPane ref={(handle) => { if (handle) terminalRefs.current.set(id, handle); else terminalRefs.current.delete(id); }} sessionId={id} active={focusedSessionId === id} label={session.label} />
                {session.status !== "connected" && session.status !== "connecting" && session.status !== "authenticating" && <div className="disconnect-banner"><WifiOff size={15} /><span>{session.message || session.reason || "Session disconnected"}</span>{!session.local && <button className="button compact" onClick={() => { setFocusedSessionId(id); void reconnect(); }}><RefreshCw size={14} /> Reconnect</button>}</div>}
              </div>;
            })}
          </div>
        </main>

        {inspectorOpen && <Inspector
          activeSession={focusedSession}
          selectedHost={focusedSession?.hostId ? catalog.hosts.find((host) => host.id === focusedSession.hostId) ?? selectedHost : selectedHost}
          snippets={catalog.snippets}
          transfers={transfers}
          tunnels={tunnels}
          view={inspectorView}
          onViewChange={setInspectorView}
          onEditHost={(host) => setHostDialog(host)}
          onRunSnippet={runSnippet}
          onSaveSnippet={saveSnippet}
          onDeleteSnippet={deleteSnippet}
          onTunnelStart={startTunnel}
          onTunnelStop={stopTunnel}
          onCancelTransfer={cancelTransfer}
          onRetryTransfer={retryTransfer}
          onToast={showToast}
        />}
      </div>

      <footer className="app-statusbar">
        <span><StatusDot state={syncStatus?.state ?? "offline"} /> {syncStatus?.configured ? syncStatus?.user ? `Cloud · ${syncStatus.state}` : "Cloud signed out" : "Local only"}</span>
        {syncStatus?.pending > 0 && <span>{syncStatus.pending} pending</span>}
        <span className="status-spacer" />
        <span>{tabs.length} session{tabs.length === 1 ? "" : "s"}</span>
        <span>{transfers.filter((job) => job.state === "running" || job.state === "queued").length} transfers</span>
        <span>{tunnels.length} tunnels</span>
        <span><KeyRound size={13} /> Vault unlocked</span>
      </footer>

      {hostDialog && <HostDialog initial={hostDialog === "new" ? null : hostDialog} catalog={catalog} onClose={() => setHostDialog(null)} onSave={saveHost} onDelete={deleteHost} />}
      {groupDialog && <GroupDialog groups={catalog.groups} keys={catalog.keys} onClose={() => setGroupDialog(false)} onSave={async (input) => { await api.groups.save(input); await reloadCatalog(); }} onDelete={async (id) => { await api.groups.remove(id); await reloadCatalog(); }} onToast={showToast} />}
      {settingsOpen && <SettingsDialog catalog={catalog} onCatalogChange={reloadCatalog} onClose={() => setSettingsOpen(false)} onToast={showToast} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {hostKeyPrompt && <HostKeyDialog prompt={hostKeyPrompt} onAnswer={(accept) => { void api.session.answerHostKey(hostKeyPrompt.sessionId, accept); setHostKeyPrompt(null); }} />}
      {authPrompt && <AuthPromptDialog prompt={authPrompt} onAnswer={(answers) => { if (answers) void api.session.answerAuthPrompt(authPrompt.sessionId, answers); else void api.session.close(authPrompt.sessionId); setAuthPrompt(null); }} />}
      {toast && <button className={`toast ${toast.tone}`} onClick={() => setToast(null)}>{toast.tone === "danger" ? <WifiOff size={15} /> : <Clipboard size={15} />}{toast.message}<X size={13} /></button>}
    </div>
  );
}