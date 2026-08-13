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
import { api, bridgeUnavailable, isMockApi } from "./api";
import { AuthPromptDialog, CommandPalette, GroupDialog, HostDialog, HostKeyDialog, SettingsDialog, VaultScreen } from "./Dialogs";
import { Inspector } from "./Inspector";
import { ResourceExplorer } from "./ResourceExplorer";
import { TerminalPane, type TerminalHandle } from "./TerminalPane";
import type { Catalog, Host, Session, TransferJob, Tunnel } from "./types";
import { EnvironmentBadge, IconButton, StatusDot, useConfirm } from "./ui";

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
  if (bridgeUnavailable) {
    return (
      <div className="vault-screen">
        <div className="vault-panel">
          <div className="vault-brand"><span>W</span><div><strong>WANN SSH</strong><small>Secure operations workspace</small></div></div>
          <div className="vault-title-block">
            <small>Runtime unavailable</small>
            <h1>Secure bridge failed to load</h1>
            <p>Close this window and reopen the SSH module. No demo data has been loaded.</p>
          </div>
          <div className="security-note"><WifiOff size={17} /><span>The Electron preload API is required in production.</span></div>
        </div>
      </div>
    );
  }
  return <SshApp />;
}

function SshApp() {
  const [vaultState, setVaultState] = useState<VaultState>("loading");
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [tabs, setTabs] = useState<string[]>([]);
  const [panes, setPanes] = useState<string[]>([]);
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
  const [tabMenu, setTabMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<"add" | "single" | null>(null);
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const MAX_PANES = 4;
  const terminalRefs = useRef(new Map<string, TerminalHandle>());
  const mockOpened = useRef(false);
  const confirm = useConfirm();

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
      setPanes([]);
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
    // Sesi baru selalu jadi satu-satunya pane aktif (keluar dari mode split).
    setPanes([session.sessionId]);
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
      if (await confirm({ title: "Save recording?", message: "This session has an active recording. Save it before closing?", confirmLabel: "Save", cancelLabel: "Discard" })) {
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
      setPanes((current) => {
        const remaining = current.filter((id) => id !== sessionId);
        return remaining.length ? remaining : (fallback ? [fallback] : []);
      });
      setFocusedSessionId((value) => value === sessionId ? fallback : value);
      return next;
    });
  }, [recording, confirm]);

  const selectTab = (sessionId: string) => {
    // Klik tab: jika belum tampil di pane manapun, tampilkan sebagai pane tunggal.
    setPanes((current) => current.includes(sessionId) ? current : [sessionId]);
    setFocusedSessionId(sessionId);
  };

  const toggleSplit = () => {
    if (panes.length > 1) {
      setPanes([focusedSessionId ?? panes[0]]);
      setFocusedSessionId(focusedSessionId ?? panes[0]);
      return;
    }
    const other = tabs.find((id) => id !== panes[0]) ?? null;
    if (!other) return;
    setPanes([panes[0], other]);
    setFocusedSessionId(panes[0]);
  };

  /** Tambahkan sesi ke grid split (maks 4 pane). */
  const splitWith = (sessionId: string) => {
    setPanes((current) => {
      if (current.includes(sessionId)) return current;
      if (current.length >= MAX_PANES) return [...current.slice(1), sessionId];
      return [...current, sessionId];
    });
    setFocusedSessionId(sessionId);
  };

  /** Tampilkan hanya sesi ini (keluar dari split). */
  const showSingle = (sessionId: string) => {
    setPanes([sessionId]);
    setFocusedSessionId(sessionId);
  };

  const removeFromSplit = (sessionId: string) => {
    setPanes((current) => {
      const next = current.filter((id) => id !== sessionId);
      return next.length ? next : current;
    });
    setFocusedSessionId((value) => value === sessionId ? (panes.find((id) => id !== sessionId) ?? value) : value);
  };

  const closeSplit = () => {
    const keep = focusedSessionId && panes.includes(focusedSessionId) ? focusedSessionId : panes[0];
    setPanes(keep ? [keep] : []);
    setFocusedSessionId(keep ?? null);
  };

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setTabMenu(null); };
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("keydown", onKey); };
  }, [tabMenu]);

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
    if (!await confirm({ title: "Add to Chat context?", message: `Add ${Math.min(selection.length, 50_000).toLocaleString()} characters from ${focusedSession.label} to Chat context. Nothing will be sent automatically.`, confirmLabel: "Add to Chat" })) return;
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
  }, [panes, focusedSessionId, tabs]);

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
              {(() => {
                const renderTab = (id: string) => {
                  const session = sessions[id];
                  if (!session) return null;
                  const selected = focusedSessionId === id;
                  return <button
                    className={`session-tab ${selected ? "active" : ""}`}
                    key={id}
                    draggable
                    onClick={() => selectTab(id)}
                    onContextMenu={(event) => { event.preventDefault(); setTabMenu({ sessionId: id, x: event.clientX, y: event.clientY }); }}
                    onDragStart={(event) => { setDraggingTab(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }}
                    onDragEnd={() => { setDraggingTab(null); setDropTarget(null); }}
                  >
                    <span className={`session-environment ${session.environment}`} />
                    <StatusDot state={session.status} />
                    <span>{session.label}</span>
                    <EnvironmentBadge environment={session.environment} />
                    <span className="tab-close" role="button" aria-label="Close" onClick={(event) => { event.stopPropagation(); void closeSession(id); }}><X size={13} /></span>
                  </button>;
                };
                // Saat split (≥2 pane), semua pane dikelompokkan dalam satu grup visual.
                if (panes.length < 2) return tabs.map(renderTab);
                const grouped = new Set(panes);
                const nodes: ReactNode[] = [];
                let groupRendered = false;
                for (const id of tabs) {
                  if (grouped.has(id)) {
                    if (groupRendered) continue;
                    groupRendered = true;
                    nodes.push(
                      <div className="tab-group" key="split-group">
                        <span className="tab-group-label"><SplitSquareHorizontal size={11} /> Split {panes.length}</span>
                        <div className="tab-group-items">
                          {panes.map(renderTab)}
                        </div>
                        <button className="tab-group-close" title="Tutup split" onClick={closeSplit}><X size={12} /></button>
                      </div>
                    );
                  } else {
                    nodes.push(renderTab(id));
                  }
                }
                return nodes;
              })()}
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
              <IconButton label={panes.length > 1 ? "Close split" : "Split terminal"} disabled={tabs.length < 2} onClick={toggleSplit}><SplitSquareHorizontal size={15} /></IconButton>
              <IconButton className={recording[focusedSessionId ?? ""] ? "recording" : ""} label={recording[focusedSessionId ?? ""] ? "Stop and save recording" : "Start recording"} disabled={!focusedSession} onClick={() => void toggleRecording()}>{recording[focusedSessionId ?? ""] ? <CircleStop size={15} /> : <Radio size={15} />}</IconButton>
              <IconButton label="Add selection to Chat" disabled={!focusedSession} onClick={() => void sendSelectionToChat()}><Bot size={15} /></IconButton>
              <span className="toolbar-separator" />
              <IconButton className={inspectorOpen ? "active" : ""} label={inspectorOpen ? "Hide inspector" : "Show inspector"} onClick={() => setInspectorOpen((value) => !value)}><PanelRight size={15} /></IconButton>
            </div>
          </div>

          <div className={`terminal-grid ${panes.length > 1 ? "split" : ""}`} data-panes={panes.length}>
            {tabs.length === 0 && <div className="workspace-empty"><TerminalSquare size={34} /><strong>Start an operational session</strong><p>Select a host and press Connect, or open a local shell.</p><div><button className="button primary" disabled={!selectedHost} onClick={() => selectedHost && void openHost(selectedHost)}><Play size={15} /> Connect {selectedHost?.label ?? "host"}</button><button className="button" onClick={() => void openLocal()}><SquareTerminal size={15} /> Local shell</button></div></div>}
            {tabs.map((id) => {
              const session = sessions[id];
              if (!session) return null;
              const paneIndex = panes.indexOf(id);
              const visible = paneIndex !== -1;
              // Posisi grid eksplisit; 3 pane → pane ketiga melebar penuh di baris 2.
              let placement: { gridColumn: string; gridRow: string } | undefined;
              if (visible && panes.length > 1) {
                const spanFull = panes.length === 3 && paneIndex === 2;
                placement = spanFull
                  ? { gridColumn: "1 / -1", gridRow: "2" }
                  : { gridColumn: String((paneIndex % 2) + 1), gridRow: String(Math.floor(paneIndex / 2) + 1) };
              }
              return <div key={id} className={`terminal-surface ${visible ? "visible" : "hidden"} ${focusedSessionId === id ? "focused" : ""}`} style={placement} onMouseDown={() => setFocusedSessionId(id)}>
                {panes.length > 1 && <button className="pane-close" title="Tutup pane" onClick={(event) => { event.stopPropagation(); removeFromSplit(id); }}><X size={13} /></button>}
                <TerminalPane ref={(handle) => { if (handle) terminalRefs.current.set(id, handle); else terminalRefs.current.delete(id); }} sessionId={id} visible={visible} active={focusedSessionId === id} label={session.label} />
                {session.status !== "connected" && session.status !== "connecting" && session.status !== "authenticating" && <div className="disconnect-banner"><WifiOff size={15} /><span>{session.message || session.reason || "Session disconnected"}</span>{!session.local && <button className="button compact" onClick={() => { setFocusedSessionId(id); void reconnect(); }}><RefreshCw size={14} /> Reconnect</button>}</div>}
              </div>;
            })}
            {draggingTab && tabs.length > 0 && (
              <div className="tab-drop-overlay">
                <div
                  className={`tab-drop-zone left ${dropTarget === "single" ? "over" : ""}`}
                  onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget("single"); }}
                  onDragLeave={() => setDropTarget((current) => current === "single" ? null : current)}
                  onDrop={(event) => { event.preventDefault(); const id = draggingTab; setDraggingTab(null); setDropTarget(null); if (id) showSingle(id); }}
                ><SquareTerminal size={20} /><span>Tampilkan sendiri</span></div>
                <div
                  className={`tab-drop-zone right ${dropTarget === "add" ? "over" : ""} ${panes.length >= MAX_PANES ? "disabled" : ""}`}
                  onDragOver={(event) => { if (panes.length >= MAX_PANES) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget("add"); }}
                  onDragLeave={() => setDropTarget((current) => current === "add" ? null : current)}
                  onDrop={(event) => { event.preventDefault(); const id = draggingTab; setDraggingTab(null); setDropTarget(null); if (id && panes.length < MAX_PANES) splitWith(id); }}
                ><SplitSquareHorizontal size={20} /><span>{panes.length >= MAX_PANES ? "Split penuh (maks 4)" : `Tambah ke split (${panes.length}/${MAX_PANES})`}</span></div>
              </div>
            )}
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

      {tabMenu && (() => {
        const menuSession = sessions[tabMenu.sessionId];
        if (!menuSession) return null;
        const inSplit = panes.includes(tabMenu.sessionId);
        const canAdd = tabs.length > 1 && !inSplit && panes.length < MAX_PANES;
        return <>
          <button className="context-menu-backdrop" aria-label="Close menu" onMouseDown={() => setTabMenu(null)} onContextMenu={(event) => { event.preventDefault(); setTabMenu(null); }} />
          <div className="context-menu" style={{ left: tabMenu.x, top: tabMenu.y }} role="menu">
            <button role="menuitem" onClick={() => { selectTab(tabMenu.sessionId); setTabMenu(null); }}><TerminalSquare size={14} /> Fokuskan tab</button>
            {canAdd && <button role="menuitem" onClick={() => { splitWith(tabMenu.sessionId); setTabMenu(null); }}><SplitSquareHorizontal size={14} /> Tambah ke split ({panes.length}/{MAX_PANES})</button>}
            {panes.length > 1 && <button role="menuitem" onClick={() => { showSingle(tabMenu.sessionId); setTabMenu(null); }}><SquareTerminal size={14} /> Tampilkan sendiri</button>}
            {inSplit && panes.length > 1 && <button role="menuitem" onClick={() => { removeFromSplit(tabMenu.sessionId); setTabMenu(null); }}><X size={14} /> Keluarkan dari split</button>}
            {panes.length > 1 && <button role="menuitem" onClick={() => { closeSplit(); setTabMenu(null); }}><X size={14} /> Tutup split</button>}
            <span className="context-menu-separator" />
            <button role="menuitem" className="danger" onClick={() => { const id = tabMenu.sessionId; setTabMenu(null); void closeSession(id); }}><Trash2 size={14} /> Tutup tab</button>
          </div>
        </>;
      })()}
    </div>
  );
}