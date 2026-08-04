import { useDeferredValue, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Laptop, Plus, Search, Server, Settings, Star, TerminalSquare } from "lucide-react";
import type { Group, Host } from "./types";
import { EnvironmentBadge, IconButton } from "./ui";

type Props = {
  hosts: Host[];
  groups: Group[];
  selectedHostId: string | null;
  connectingHostId: string | null;
  onSelect: (hostId: string) => void;
  onConnect: (host: Host) => void;
  onNewHost: () => void;
  onNewGroup: () => void;
  onOpenLocal: () => void;
  onSettings: () => void;
  onToggleFavorite: (host: Host) => void;
};

function HostRow({ host, selected, connecting, onSelect, onConnect, onToggleFavorite }: { host: Host; selected: boolean; connecting: boolean; onSelect: () => void; onConnect: () => void; onToggleFavorite: () => void }) {
  return (
    <div className={`host-item ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className={`host-environment ${host.environment}`} />
      <Server size={15} className="host-icon" aria-hidden="true" />
      <span className="host-copy">
        <span className="host-name">{host.label}</span>
        <span className="host-address">{host.effectiveUsername ? `${host.effectiveUsername}@` : ""}{host.address}</span>
      </span>
      <EnvironmentBadge environment={host.environment} />
      <IconButton className="row-action" label={host.favorite ? "Hapus dari favorit" : "Tambahkan ke favorit"} onClick={(event) => { event.stopPropagation(); onToggleFavorite(); }}>
        <Star size={14} fill={host.favorite ? "currentColor" : "none"} />
      </IconButton>
      <button className="connect-button" disabled={connecting} onClick={(event) => { event.stopPropagation(); onConnect(); }}>
        {connecting ? <span className="spinner" /> : <TerminalSquare size={14} />}
        <span>{connecting ? "Menghubungkan" : "Connect"}</span>
      </button>
    </div>
  );
}

export function ResourceExplorer(props: Props) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const visibleHosts = useMemo(() => {
    if (!deferredQuery) return props.hosts;
    return props.hosts.filter((host) => [
      host.label,
      host.address,
      host.effectiveUsername ?? "",
      host.environment,
      ...(host.tags ?? []),
      ...(host.groupPath ?? [])
    ].join(" ").toLowerCase().includes(deferredQuery));
  }, [deferredQuery, props.hosts]);
  const favorites = visibleHosts.filter((host) => host.favorite);
  const grouped = useMemo(() => {
    const buckets = new Map<string, Host[]>();
    for (const host of visibleHosts) {
      const key = host.groupPath?.join(" / ") || "Ungrouped";
      const rows = buckets.get(key) ?? [];
      rows.push(host);
      buckets.set(key, rows);
    }
    return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleHosts]);

  const renderHost = (host: Host) => (
    <HostRow
      key={host.id}
      host={host}
      selected={props.selectedHostId === host.id}
      connecting={props.connectingHostId === host.id}
      onSelect={() => props.onSelect(host.id)}
      onConnect={() => props.onConnect(host)}
      onToggleFavorite={() => props.onToggleFavorite(host)}
    />
  );

  return (
    <aside className="resource-explorer">
      <div className="explorer-heading">
        <span>Resources</span>
        <div className="heading-actions">
          <IconButton label="Buat grup" onClick={props.onNewGroup}><FolderPlus size={15} /></IconButton>
          <IconButton label="Tambah host" onClick={props.onNewHost}><Plus size={16} /></IconButton>
        </div>
      </div>
      <div className="host-search">
        <Search size={14} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Host, tag, address" />
      </div>
      <div className="resource-scroll">
        {favorites.length > 0 && (
          <section className="resource-section">
            <button className="section-title" onClick={() => setCollapsed((value) => ({ ...value, favorites: !value.favorites }))}>
              {collapsed.favorites ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <Star size={13} />
              <span>Favorites</span>
              <span className="count">{favorites.length}</span>
            </button>
            {!collapsed.favorites && <div className="host-list">{favorites.map(renderHost)}</div>}
          </section>
        )}
        {grouped.map(([group, hosts]) => {
          const key = `group:${group}`;
          return (
            <section className="resource-section" key={group}>
              <button className="section-title" onClick={() => setCollapsed((value) => ({ ...value, [key]: !value[key] }))}>
                {collapsed[key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                <Folder size={13} />
                <span>{group}</span>
                <span className="count">{hosts.length}</span>
              </button>
              {!collapsed[key] && <div className="host-list">{hosts.map(renderHost)}</div>}
            </section>
          );
        })}
        {visibleHosts.length === 0 && (
          <div className="empty-resource">
            <Server size={24} />
            <span>{props.hosts.length ? "Tidak ada hasil" : "Belum ada host"}</span>
            {!props.hosts.length && <button className="button primary" onClick={props.onNewHost}><Plus size={15} /> Tambah host</button>}
          </div>
        )}
      </div>
      <div className="explorer-footer">
        <button className="nav-button" onClick={props.onOpenLocal}><Laptop size={15} /> Local shell</button>
        <IconButton label="Settings" onClick={props.onSettings}><Settings size={16} /></IconButton>
      </div>
    </aside>
  );
}