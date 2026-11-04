# Desktop and phone status

The read-only status app lets the owner see what the agent is doing from a phone or a second desktop without opening
the full management panel. It is the same data the panel shows, served by the same Host process from `/status`. It has
no write controls: pausing, stopping, retrying, answering or changing settings stay in the Web panel, Feishu or GitHub.

This page covers enabling it, pairing a device, exposing it safely over TLS, and what it deliberately does not do.
Configuration keys are in the Machine configuration table of [006 Deployment](006-deployment.md).

## What it serves

| Path | Content |
| --- | --- |
| `/status/` | The app: overview, Tickets, one Ticket, activity, pairing, and this Mac's pairing page |
| `/status/api/summary` | Instance, health, pause state, Tickets waiting for a person, problems, executor load, 24-hour flow and Source health, with `asOf` |
| `/status/api/tickets?state=open\|person\|working\|idle\|ended` | The panel's Ticket list, paged |
| `/status/api/tickets/:id` | The panel's Ticket detail: stage, decisions, assignments, reports, inputs, Threads and links |
| `/status/api/activity` | Recent decisions |
| `/status/api/setup`, `/status/api/devices/code`, `/status/api/devices/:id` | Pairing and device management; only from the Host machine |
| `/status/api/pair`, `/status/pair` | One-time pairing from a phone or another computer |

The app shell, manifest, service worker and icons are public: they contain no data. Every `/status/api` read requires
either a loopback request (the owner's own browser on the Host) or a valid paired-device cookie, and every data route is
a `GET`; there is no write route to authorize. The surface is off unless `status.enabled` is true.

## Enable it

1. Set `status.enabled: true` in the `dsh-superagent` entry of the profile's `cordis.patch.yml` and restart.
2. For a phone or another computer, also set `status.publicUrl` to the HTTPS origin that reaches this Host, for example
   `https://mac-mini.tailnet.ts.net`, and restart. An empty `publicUrl` keeps the surface local to the Host machine.
3. Open `http://127.0.0.1:<port>/status/setup` on the Host (the panel's **手机/桌面** header button opens the app, whose
   **配对** (Pairing) tab is this page). The page shows the phone URL, generates one-time pairing
   codes, and lists paired devices with a revoke button.

`status.publicUrl` must be a bare `https://` origin: no path, query, credentials or fragment. Remote requests are
served only when their `Host` matches it, so the proxy in front must preserve the original `Host`.

## Pair a device

1. On the Host, open `/status/setup` and choose **Generate code**. A short code is valid for one minute and once.
2. On the phone or the other computer, open `https://<public host>/status/pair` and enter the code (or open the setup
   page's pairing URL with a `#code=` fragment, which the page submits without sending the fragment to the server).
3. The device receives an `HttpOnly`, `SameSite=Strict` cookie scoped to `/status`, `Secure` when the request came over
   TLS. The cookie grants read-only access for `status.sessionTtlDays` (default 30, at most 90).
4. Revoke a device from `/status/setup` or by deleting its record. The next request from that device gets `401`, and the
   app falls back to its pairing page.

Pairing codes and failed attempts are limited to five per minute per client address. The device list stores a short hash
of the browser's User-Agent, never the header itself, and no message body is stored on the device.

## Expose it safely

The default is loopback only. For a phone, use a TLS path rather than opening the Host's port directly:

- **Tailscale Serve (recommended for one person).** Serve the DSH port on the tailnet with HTTPS:
  `tailscale serve --bg https / http://127.0.0.1:<port>`. Set `status.publicUrl` to the tailnet origin; the proxy
  preserves `Host`, and Tailscale provides a trusted certificate.
- **Reverse proxy with TLS.** Terminate TLS in Caddy or Nginx, forward to `127.0.0.1:<port>`, preserve `Host`, set
  `X-Forwarded-Proto: https`, and do not cache `/status/api` responses. Set `status.publicUrl` to the public origin.

A request to `status.publicUrl` over plain HTTP is refused, as is a request for any other `Host`. The phone browser needs
HTTPS anyway for the service worker and installation. Do not publish the port on the public internet with an overlay or
proxy you do not trust.

The management routes under `/orchestrator/api` remain loopback-only: even when the Web server is bound beyond
loopback so the phone can reach `/status`, `sameOrigin()` admits only a loopback-origin panel request. Pairing on the
phone never grants the ability to manage.

## Install it

The app is a PWA. On iOS Safari use Share → Add to Home Screen; on Android Chrome and on desktop Chrome/Edge use Install
app (Safari 17+ on macOS supports Add to Dock). The app opens standalone at `/status/` and caches its shell, so it still
opens offline. The last summary is kept in `localStorage` and shown with a yellow "offline, showing the snapshot from
HH:MM" banner; details are read from the network and are never cached as a body.

## Limits

- **Read-only.** There is no pause, stop, retry, answer or settings action, and the read-only data routes cannot be
  turned into writes. Use the panel, Feishu or GitHub to act.
- **Desktop.** The installed PWA is the desktop app. It runs in its own window from Chrome, Edge or Safari; there is no
  tray icon, global shortcut or separate Electron/Tauri package. DSH Desktop compatibility is not verified here.
- **No push.** Feishu remains the notification channel. The app polls every 15 seconds while visible and refreshes on
  resume; it is not a real-time stream.
- **No multi-instance aggregation.** One Host serves one instance; the summary carries the instance id for later work.
- **Not for sharing.** A paired device is the owner's own device with full read access. There is no redacted viewer
  role yet.
- **No offline actions.** The snapshot is for reading; actions always need a connection.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `/status` returns 404 | `status.enabled` is false or the plugin has not restarted after the change |
| Remote phone gets `403 remoteDisabled` | `status.publicUrl` is empty; set it and restart |
| Remote phone gets `403 httpsRequired` | The request arrived over plain HTTP; reach it through the TLS tunnel or proxy and preserve `Host` |
| Remote phone gets `403 untrustedHost` | The request `Host` is not `status.publicUrl`; check the proxy preserves `Host` |
| Remote phone gets `401 unpaired` | Pair the device from the Host's `/status/setup`; the code expires after one minute |
| Setup page says devices are managed on the Host | `/status/setup` is loopback-only; open it on the Host machine |
| App opens but shows an offline snapshot | The Host is down or the cookie was revoked; restart the Host and pair again if needed |
| App JS returns 503 | The package was not built; run `pnpm build` so `lib/status-app.js` exists |
