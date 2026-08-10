import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const alertsPath = path.join(root, "ops/prometheus/alerts.yml");
const alertTestsPath = path.join(root, "ops/prometheus/alert-tests.yml");
const dashboardPath = path.join(root, "ops/grafana/dashboards/wan-router.json");
const alerts = parse(await readFile(alertsPath, "utf8")) as {
  groups?: Array<{ rules?: Array<Record<string, unknown>> }>;
};
const tests = parse(await readFile(alertTestsPath, "utf8")) as {
  tests?: Array<{ alert_rule_test?: Array<{ alertname?: string }> }>;
};
const dashboard = JSON.parse(await readFile(dashboardPath, "utf8")) as {
  uid?: string;
  panels?: Array<{ title?: string; targets?: Array<{ expr?: string }> }>;
};

const rules = alerts.groups?.flatMap((group) => group.rules ?? []) ?? [];
if (rules.length < 8) throw new Error("OBS-01 requires at least eight alert rules.");
for (const rule of rules) {
  if (typeof rule.alert !== "string" || typeof rule.expr !== "string") throw new Error("Every alert requires a name and expression.");
  const labels = rule.labels as Record<string, unknown> | undefined;
  const annotations = rule.annotations as Record<string, unknown> | undefined;
  if (!labels || !["page", "ticket"].includes(String(labels.severity)) || !labels.owner) {
    throw new Error(`${rule.alert} requires severity and owner labels.`);
  }
  if (!annotations?.summary || !String(annotations.runbook_url || "").includes("OBSERVABILITY-RUNBOOK.md#")) {
    throw new Error(`${rule.alert} requires summary and runbook URL annotations.`);
  }
}
const testedAlerts = new Set(
  (tests.tests ?? []).flatMap((entry) => entry.alert_rule_test ?? []).map((entry) => entry.alertname),
);
for (const required of [
  "WanRouterDatabaseUnavailable",
  "WanRouterKmsFailure",
  "WanRouterAuditPipelineFailure",
  "WanRouterStaleGeneration",
]) {
  if (!testedAlerts.has(required)) throw new Error(`${required} requires a promtool test fixture.`);
}
if (dashboard.uid !== "wan-router-operations" || (dashboard.panels?.length ?? 0) < 10) {
  throw new Error("WAN Router Grafana dashboard is incomplete.");
}
const expressions = JSON.stringify(dashboard.panels?.flatMap((panel) => panel.targets ?? []));
for (const metric of [
  "wan_router_http_requests_total",
  "wan_router_generation_ttft_seconds_bucket",
  "wan_router_provider_attempts_total",
  "wan_router_kms_failures_total",
  "wan_router_audit_failures_total",
]) {
  if (!expressions.includes(metric)) throw new Error(`Dashboard does not query ${metric}.`);
}
console.log(`Observability resources validated (${rules.length} alerts, ${dashboard.panels?.length} panels).`);