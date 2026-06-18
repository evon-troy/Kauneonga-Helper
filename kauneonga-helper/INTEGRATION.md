# Integrating the Kauneonga Helper into your Electron app

This folder is a drop-in package. It adds a "Workstation health" window to your
existing Electron project, backed by **real** system data (via
[`systeminformation`](https://github.com/sebhildebrandt/systeminformation)) and
your backend policy data.

```
kauneonga-helper/
├── main/
│   └── system-facts.js     ← MAIN process: collects real OS facts → FACTS shape
├── preload.js              ← contextBridge → window.kauneonga.getFacts()
├── main-snippet.js         ← copy these pieces into your main process
└── renderer/
    ├── index.html          ← window entry (bootstrap fetches facts, then mounts)
    ├── helper-app.jsx       ← the 4-screen UI (Overview / System / Network / Validation)
    ├── helper.css
    ├── icons.jsx
    ├── toast.jsx
    └── assets/             ← design tokens + brand font
```

## 1. Install the one dependency

```bash
npm i systeminformation
```

React + Babel currently load from CDN inside `renderer/index.html`. For a
production desktop build you'll want them bundled offline — see step 5.

## 2. Drop the folder into your project

Copy `kauneonga-helper/` next to your main process file (or anywhere; just fix
the `path.join` references in `main-snippet.js`).

## 3. Wire the main process

Open `main-snippet.js` and copy its three pieces into your existing main file:

- `ipcMain.handle("kauneonga:get-facts", …)` — runs the collector. Wire
  `policyOverride` to your backend for the things the OS can't know: agent
  identity, validation sign-off, workspace checklist, approved-device lists,
  last speed-test result, MFA status.
- `ipcMain.handle("kauneonga:send-report", …)` — POSTs the signed health
  report to your backend.
- `createHelperWindow()` — opens the window with the preload attached. Call it
  from your menu / tray / nav, or `app.whenReady().then(createHelperWindow)`.

The window **must** use `contextIsolation: true` + `nodeIntegration: false` —
the preload bridge depends on it, and it keeps the renderer sandboxed.

## 4. How the data flows

```
renderer/index.html (bootstrap)
   └─ window.kauneonga.getFacts()        [preload.js]
        └─ ipcRenderer.invoke("kauneonga:get-facts")
             └─ collectFacts(policy)      [main/system-facts.js]  ← REAL OS data
        ← FACTS object
   window.__KAUNEONGA_FACTS__ = facts
   → injects helper-app.jsx, which reads that global
```

`helper-app.jsx` reads `window.__KAUNEONGA_FACTS__` and falls back to a mock
object if it's absent — so the same file still renders in a plain browser for
design work.

## 5. What's real vs. what you must wire

**Real from the OS today** (in `system-facts.js`): CPU model/cores/arch, total &
free RAM + type, disk size/free/SSD, OS name/version/build, network interface +
link speed + MAC + IPv4 + gateway, display resolution + external monitor,
battery/power, audio devices, uptime, hostname, antivirus products (Security
Center / WMI on Windows, known app bundles on macOS), VPN interface detection,
and OS pending-updates count.

**You must wire these** — they come from the Liberty backend via the sign-in
+ policy flow in §6:

| Field | Source |
|---|---|
| `agentName / email / extension / state / profileType` | `GET /api/v1/helper/policy` — see §6 |
| `bandwidth` | run a speed test (e.g. `@cloudflare/speedtest`) and pass the result |
| `mfa` | `GET /api/v1/helper/policy` — see §6 |
| `workspace` + `validation` | `GET /api/v1/helper/policy` — see §6 |
| `cpu.approved` | `approvedCpu` list in `system-facts.js`, optionally overridden by `GET /api/v1/helper/policy` — see §6 |
| `audio.pcReadyCertified` | edit the vendor regex in `certifiedHeadset()` in `system-facts.js` |

## 6. Backend integration: sign-in, policy, and approved-device lists

Set `KAUNEONGA_API_URL` to your Liberty API base URL (e.g.
`https://app.libertydiagnostic.com`) to turn on:

- A one-time sign-in screen (Liberty email + password) shown before the
  dashboard loads, authenticating against Liberty's **existing** JWT login
  (`API::V2::Auth`). The access/refresh token pair is stored encrypted on disk
  via Electron's `safeStorage` (`kauneonga-helper/main/auth.js`) and reused on
  future launches. The "Sign out" link in the header invalidates the session
  server-side and clears it locally.
- A policy fetch before every scan that fills in everything `system-facts.js`
  can't see from the OS: agent identity, workspace checklist, validation
  sign-off, MFA status, and approved-device-list overrides.
- Authenticated health-report uploads — adds `Authorization: Bearer
  <accessToken>` to the existing `POST` from `kauneonga:send-report`.
- Silent token refresh: any `apiFetch()` call (policy or health-report) that
  gets a `401` automatically calls the refresh endpoint and retries once. If
  the refresh token is also invalid, the local session is cleared and the
  sign-in screen reappears on next launch.

If `KAUNEONGA_API_URL` is unset, sign-in is skipped entirely and the Helper
runs fully offline with the local defaults from §5 — useful for `npm run dev`
without a backend.

### Endpoints

The auth endpoints already exist in `liberty-platform` (`app/api/v2/auth.rb`,
`API::V2::JWTAuthMiddleware`). The policy and health-report endpoints are new.

| Method & path | Request | Response | Used for |
|---|---|---|---|
| `POST /api/v2/auth/login` *(existing)* | `{ email, password, type: "agent" }` | `{ accessToken, refreshToken, device_token_registered }` | Sign-in screen. |
| `POST /api/v2/auth/refresh` *(existing)* | `{ refresh_token }` | `{ access_token, refresh_token }` | Silent refresh on a `401`. |
| `POST /api/v2/auth/logout` *(existing)* | `Authorization: Bearer <accessToken>` | `{ message }` | "Sign out" link. |
| `GET /api/v2/helper/policy` **(new)** | `Authorization: Bearer <accessToken>` | shape below | Fetched before every scan; merged into `collectFacts(policyOverride)`. |
| `POST /api/v2/health_reports` **(new)** | `Authorization: Bearer <accessToken>`, body = the full FACTS object | `{ id, receivedAt }` | "Send health report" button. |

`GET /api/v2/helper/policy` returns a subset of:

```json
{
  "agentName": "Logan Shooster",
  "agentEmail": "logan.shooster@kauneonga.com",
  "extension": "1042",
  "state": "NY",
  "profileType": "Permanent agent · Berkshire Medical",
  "approvedCpu": ["Apple M", "Core i5", "Core i7", "Core i9", "Ryzen 5", "Ryzen 7", "Ryzen 9"],
  "mfa": { "enabled": true, "methods": ["TOTP", "WebAuthn"] },
  "workspace": { "quiet": true, "private": true, "secure": true, "safe": true, "clean": true, "notes": "" },
  "validation": { "completedBy": "Karen Liu (Supervisor)", "completedAt": "2026-05-18 10:14", "status": "eligible", "tempAccommodation": false, "eligible": true }
}
```

Any field you omit keeps its `DEFAULT_POLICY` default in `system-facts.js`
(`null` → renders as "Pending Liberty" and stays verdict-neutral). Sending
`approvedCpu` lets the backend manage the approved-device list centrally
instead of editing `system-facts.js` per install.

### Status on the `liberty-platform` side

`agentName`/`agentEmail` map to the `Agent` model's existing `first_name` /
`last_name` / `email`. The rest is implemented on
`claude/helper-integration-staging` (off `staging`):

- `Agent` has `extension`, `state`, and `profile_type` columns
  (`db/migrate/20260615150000_add_helper_fields_to_agents.rb`).
- `workspace` and `validation` are backed by `AgentWorkspaceChecklist`
  (`has_one :workspace_checklist` on `Agent`), supervisor-editable via
  `completed_by`/`completed_at`/`status`/`temp_accommodation`/`eligible`.
- `mfa` is derived from `second_factors` (TOTP) and `passkeys` (WebAuthn) via
  `API::V2::Decorators::HelperPolicyDecorator`.
- `HealthReport` stores the posted FACTS JSON; `POST /api/v2/health_reports`
  creates one and returns `{ id, receivedAt }`.

`approvedCpu` is **not** sent by the backend yet — the Helper keeps using its
local `DEFAULT_POLICY` list until a central approved-device store is added.

## 7. Production hardening (before shipping)

- **Bundle React/Babel** instead of CDN: either vendor the UMD files locally, or
  convert the `.jsx` to a real build step (Vite/esbuild) and drop Babel. The UI
  has no other runtime deps.
- **Tighten CSP** in `index.html` — remove the CDN allowances once self-hosted.
- **Code-sign** the app (Apple Developer ID + Microsoft Authenticode) so it
  installs cleanly via Intune / Jamf / Workspace ONE.
- **Sign the health-report payload** (JWS) before `sendReport`.
- **Auto-update** via `electron-updater`.

## 8. Buttons already wired to the bridge

- **Re-scan now** → `window.kauneonga.rescan()` (re-runs the collector,
  including the policy fetch from §6)
- **Send health report** → `window.kauneonga.sendReport(FACTS)`
- **Sign out** (header) → `window.kauneonga.logout()`, then reloads to show
  the sign-in screen again

All no-op gracefully in a plain browser.
