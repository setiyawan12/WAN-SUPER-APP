# OPS-SSH-01

Repository artifacts for TLS/WSS, metrics, reconnect, and rollback. This is
not a live production deploy claim.

## Metrics

`GET /metrics` is Prometheus text on the internal gateway network. Do not route
it through the public edge. Labels are bounded. UID, email, hostname, IP,
session ID, fingerprint, credentials, and terminal content are forbidden.

Alert on:

- `wan_ssh_process_ready == 0`
- elevated `wan_ssh_ws_auth_total{result="failure"}`
- elevated `wan_ssh_sessions_open_total{result="failure"}`
- `wan_ssh_sessions_active / wan_ssh_sessions_limit >= 0.8`
- `wan_ssh_backpressure_total{action="close"}`
- container restart loop
- TLS certificate expiry
- High/Critical dependency audit

## Reconnect

Rolling restart closes WebSockets with `1012`. The browser reconnects the
socket and must open a new SSH session. Sessions are not migrated.

## Rollback

1. Keep the previous known-good image digest.
2. Mark the new instance unready until `/readyz` is 200.
3. Redeploy the previous digest. Do not `git pull` on the VPS.
4. Confirm `/healthz`, `/readyz`, `/metrics`, and one fixture SSH session.

## Credential exposure

If a private key, password, or Firebase token may have been logged or stored:

1. Rotate the SSH credential and Firebase user/session immediately.
2. Capture redacted logs and image digest only.
3. Search logs/metrics for the secret marker; treat any hit as a leak.
4. Revoke the exposed token/key and notify the tenant owner.
5. Keep terminal recordings disabled unless consent and retention exist.

## Mixed content

Production origins must be HTTPS. The web client upgrades `https:` to `wss:`.
Do not publish `ws://` or HTTP API origins on a TLS page.
