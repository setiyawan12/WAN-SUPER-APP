import assert from "node:assert/strict";
import test from "node:test";
import { GatewayMetrics } from "../src/observability/metrics.js";

test("metrics render bounded labels and omit secrets", () => {
  const metrics = new GatewayMetrics();
  metrics.snapshot = () => ({ ready: true, sessionsActive: 2, sessionsLimit: 20, wsConnections: 1 });
  metrics.recordAuth("success", "ok");
  metrics.recordAuth("failure", "user-secret");
  metrics.recordSessionOpen("failure", "TARGET_DENIED");
  metrics.recordTargetDenied("forbidden");
  metrics.recordBytes("in", 12);
  metrics.recordBytes("out", 34);
  const body = metrics.render();
  assert.match(body, /wan_ssh_process_ready 1/);
  assert.match(body, /wan_ssh_sessions_active 2/);
  assert.match(body, /wan_ssh_sessions_limit 20/);
  assert.match(body, /wan_ssh_ws_auth_total\{result="failure",reason="other"\} 1/);
  assert.match(body, /wan_ssh_sessions_open_total\{result="failure",error_code="TARGET_DENIED"\} 1/);
  assert.doesNotMatch(body, /user-secret|password|token|uid=/i);
});
