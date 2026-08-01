import { useMemo, useState } from "react";
import { Activity, CheckCircle2, CircleDollarSign, Database, Gauge, Search, ServerOff, TrendingUp, XCircle } from "lucide-react";
import { api, type ProviderModelUsage, type RecentUsageRecord } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { TrendChart, PageHeader, CommandSummary } from "../components/shared";
import { ratesFor, formatUsd, formatNumber } from "../lib/utils";
import { AuthFilesTable } from "../components/AuthFilesTable";

type SortKey = "provider" | "model" | "requests" | "input_tokens" | "output_tokens" | "total_tokens";

const SORTABLE_COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "provider", label: "Provider" },
  { key: "model", label: "Model" },
  { key: "requests", label: "Requests", right: true },
  { key: "input_tokens", label: "Input tokens", right: true },
  { key: "output_tokens", label: "Output tokens", right: true },
  { key: "total_tokens", label: "Total tokens", right: true },
];

const BUCKET_WINDOW_LABEL = "last ~3.3h";
const TOKEN_USAGE_DAYS = 7;

function estimateCostUsd(rows: ProviderModelUsage[]): number {
  return rows.reduce((sum, r) => {
    const rates = ratesFor(r.provider);
    return sum + (r.input_tokens / 1_000_000) * rates.input + (r.output_tokens / 1_000_000) * rates.output;
  }, 0);
}

export function Usage() {
  const { data: status } = usePolling(api.getStatus, 4000);
  const serverRunning = status?.running ?? false;
  const { data, error } = usePolling(api.getUsage, 10000, serverRunning);
  const { data: tokenData, error: tokenError } = usePolling(() => api.getUsageTokens(TOKEN_USAGE_DAYS), 20000, serverRunning);

  const [tableQuery, setTableQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_tokens");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const visibleRows = useMemo(() => {
    const rows = tokenData?.byProviderModel ?? [];
    const q = tableQuery.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.provider.toLowerCase().includes(q) || r.model.toLowerCase().includes(q)) : rows;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [tokenData?.byProviderModel, tableQuery, sortKey, sortDir]);

  const totalRequests = (data?.totals.success ?? 0) + (data?.totals.failed ?? 0);
  const successRate = totalRequests > 0 ? Math.round(((data?.totals.success ?? 0) / totalRequests) * 100) : null;
  const tokenTotals = tokenData?.totals;
  const totalTokens = tokenTotals?.total_tokens ?? 0;
  const cacheRate = tokenTotals && tokenTotals.input_tokens > 0 ? Math.round((tokenTotals.cached_tokens / tokenTotals.input_tokens) * 100) : 0;
  const estimatedCost = tokenData ? estimateCostUsd(tokenData.byProviderModel) : 0;

  return (
    <div className="page usage-page">
      <PageHeader
        eyebrow="Analytics"
        title="Usage"
        subtitle="Monitor requests, provider token volume, cache efficiency, and recent traffic."
      />

      <CommandSummary
        icon={<Activity size={21} />}
        eyebrow="Traffic analytics"
        title={serverRunning ? totalRequests ? `${totalRequests.toLocaleString()} requests observed` : "Waiting for request traffic" : "Usage collector offline"}
        description={`Request health uses the rolling ${BUCKET_WINDOW_LABEL} window; token totals cover the last ${TOKEN_USAGE_DAYS} days.`}
        status={
          <span className={`command-status-pill ${serverRunning ? "success" : "neutral"}`}>
            {serverRunning ? <CheckCircle2 size={13} /> : <ServerOff size={13} />}
            {serverRunning ? "Collector online" : "Server stopped"}
          </span>
        }
        metrics={[
          { label: "requests", value: totalRequests },
          { label: "success", value: successRate === null ? "—" : `${successRate}%`, tone: successRate !== null && successRate >= 95 ? "success" : successRate !== null && successRate < 90 ? "warn" : "default" },
          { label: "failed", value: data?.totals.failed ?? 0, tone: (data?.totals.failed ?? 0) ? "error" : "default" },
          { label: "tokens · 7d", value: totalTokens ? formatNumber(totalTokens) : "—" },
          { label: "cache rate", value: totalTokens ? `${cacheRate}%` : "—" },
        ]}
      />

      {!serverRunning && <div className="empty-hint">CLIProxyAPI isn't running, so there's no usage data to show. Go to Overview and click Start first.</div>}
      {serverRunning && error && <div className="empty-hint">Couldn't load usage: {error.message}</div>}

      {serverRunning && <AuthFilesTable />}

      {serverRunning && (
        <div className="card usage-ledger-card">
          <div className="usage-card-head">
            <div>
              <span className="usage-card-icon"><Database size={17} /></span>
              <div>
                <strong>Token usage by provider & model</strong>
                <span>Provider-reported totals over {TOKEN_USAGE_DAYS} days{tokenData ? ` · ${tokenData.availableDays} day(s) stored` : ""}</span>
              </div>
            </div>
            {tokenData && (
              <span className="usage-cost-pill"><CircleDollarSign size={14} />Est. {formatUsd(estimatedCost)}</span>
            )}
          </div>
          {tokenError && (
            <p className="card-desc" style={{ color: "var(--vscode-errorForeground)" }}>
              Couldn't load token usage: {tokenError.message}
            </p>
          )}
          {!tokenError && tokenData && tokenData.byProviderModel.length === 0 && (
            <p className="card-desc">No token usage recorded yet. This fills in a few minutes after requests start flowing.</p>
          )}
          {!tokenError && tokenData && tokenData.byProviderModel.length > 0 && (
            <>
              <label className="usage-search">
                <Search size={15} />
                <input value={tableQuery} onChange={(e) => setTableQuery(e.target.value)} placeholder="Filter by provider or model..." />
              </label>
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      {SORTABLE_COLUMNS.map((col) => (
                        <th key={col.key} className={col.right ? "right" : ""} onClick={() => toggleSort(col.key)}>
                          {col.label} {sortKey === col.key && (sortDir === "asc" ? "↑" : "↓")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={SORTABLE_COLUMNS.length} style={{ textAlign: "center", padding: "12px 0" }}>
                          No rows match your filter.
                        </td>
                      </tr>
                    )}
                    {visibleRows.map((row) => (
                      <tr key={`${row.provider}::${row.model}`}>
                        <td>{row.provider}</td>
                        <td className="card-desc">{row.model}</td>
                        <td className="right">{formatNumber(row.requests)}</td>
                        <td className="right">{formatNumber(row.input_tokens)}</td>
                        <td className="right">{formatNumber(row.output_tokens)}</td>
                        <td className="right" style={{ fontWeight: 600 }}>
                          {formatNumber(row.total_tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!tokenError && tokenData && tokenData.byProviderModel.length > 0 && (
            <div className="usage-estimate-note">
              <CircleDollarSign size={16} />
              <span>Static-rate estimate only; this is not provider billing data.</span>
            </div>
          )}

          {!tokenError && tokenData && tokenData.byDay.length > 1 && (
            <div className="usage-trend-block">
              <p className="card-desc"><TrendingUp size={14} />Daily total tokens</p>
              <TrendChart byDay={tokenData.byDay} />
            </div>
          )}

          {!tokenError && tokenData && tokenData.recent.length > 0 && (
            <details className="usage-recent">
              <summary>
                Recent requests ({tokenData.recent.length})
              </summary>
              <div className="usage-recent-list">
                {tokenData.recent.slice(0, 20).map((r: RecentUsageRecord, i: number) => (
                  <div key={i} className={r.failed ? "failed" : ""}>
                    <span className="usage-request-state">{r.failed ? <XCircle size={13} /> : <CheckCircle2 size={13} />}</span>
                    <span className="usage-request-time">{r.timestamp ? new Date(r.timestamp).toLocaleString() : "unknown time"}</span>
                    <span className="usage-request-model">
                      {r.provider} / {r.model}
                    </span>
                    <span className="usage-request-value">
                      {r.failed ? "failed" : `${formatNumber(r.tokens.total_tokens ?? 0)} tok`}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {serverRunning && successRate !== null && (
        <div className="usage-health-note">
          <Gauge size={16} />
          <span><strong>{successRate}% success</strong> across all connected accounts and keys.</span>
        </div>
      )}
    </div>
  );
}

