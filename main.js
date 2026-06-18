// ═══════════════════════════════════════════════════════
//  ELECTRON MAIN PROCESS
//
//  Hosts the Kauneonga Helper "Workstation health" dashboard
//  (renderer at kauneonga-helper/renderer). The main process
//  collects real system facts via systeminformation and
//  exposes them to the renderer over the `window.kauneonga`
//  bridge (see kauneonga-helper/preload.js).
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { collectFacts, detectDeferred } = require("./kauneonga-helper/main/system-facts");
const { loadSession, saveSession, clearSession } = require("./kauneonga-helper/main/auth");

const HELPER_DIR = path.join(__dirname, "kauneonga-helper");

// Liberty backend base URL. Wire to your real API; when unset, sign-in is
// skipped and policy/report sync no-op gracefully so the UI still works
// offline (see INTEGRATION.md §6 for the endpoint contract).
const API_BASE = process.env.KAUNEONGA_API_URL || "";
// Login/refresh/logout reuse Liberty's existing JWT auth (API::V2::Auth).
const LOGIN_PATH = "/api/v2/auth/login";
const REFRESH_PATH = "/api/v2/auth/refresh";
const LOGOUT_PATH = "/api/v2/auth/logout";
// Policy + health-report endpoints are new (see INTEGRATION.md §6).
const POLICY_PATH = "/api/v2/helper/policy";
const REPORT_PATH = "/api/v2/health_reports";

// Node's fetch wraps connection failures (ECONNREFUSED, DNS errors, etc.) in a
// generic "TypeError: fetch failed" and puts the real reason on err.cause —
// surface that so sign-in/report failures are debuggable from the UI.
function describeFetchError(err) {
  const cause = err && err.cause;
  if (cause && cause.message) return `${err.message}: ${cause.message}`;
  return String(err);
}

// Exchange the stored refresh token for a new access/refresh token pair.
// Returns the updated session (and persists it) on success, or null if the
// refresh token is invalid/expired — caller should treat this as signed out.
async function refreshSession(session) {
  try {
    const res = await fetch(`${API_BASE}${REFRESH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const next = { ...session, accessToken: data.access_token, refreshToken: data.refresh_token };
    saveSession(next);
    return next;
  } catch (_) {
    return null;
  }
}

// Authenticated fetch against the Liberty API. Retries once after a silent
// token refresh on 401. Returns null if no backend/session is available (the
// caller falls back to offline defaults), otherwise the fetch Response.
async function apiFetch(pathSuffix, options = {}) {
  let session = loadSession();
  if (!API_BASE || !session) return null;
  const withAuth = (token) => ({
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  let res = await fetch(`${API_BASE}${pathSuffix}`, withAuth(session.accessToken));
  if (res.status === 401) {
    session = await refreshSession(session);
    if (!session) {
      clearSession();
      return res;
    }
    res = await fetch(`${API_BASE}${pathSuffix}`, withAuth(session.accessToken));
  }
  return res;
}

// Fetch the signed-in agent's policy (identity, workspace, validation, mfa,
// approved-device overrides, …) for collectFacts(). Returns {} when no
// backend is configured or the agent isn't signed in, so collectFacts() falls
// back to its honest "Pending Liberty" defaults.
async function fetchPolicy() {
  if (!API_BASE) return {};
  try {
    const res = await apiFetch(POLICY_PATH);
    if (!res || !res.ok) return {};
    return await res.json();
  } catch (_) {
    return {};
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    title: "Kauneonga Helper",
    webPreferences: {
      preload: path.join(HELPER_DIR, "preload.js"),
      contextIsolation: true, // required — preload uses contextBridge
      nodeIntegration: false, // keep the renderer sandboxed
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(HELPER_DIR, "renderer", "index.html"));
}

app.whenReady().then(() => {
  // No backend configured → sign-in is skipped entirely (offline/dev mode).
  // Otherwise the renderer shows a sign-in screen until a session exists.
  ipcMain.handle("kauneonga:has-session", () => !API_BASE || !!loadSession());

  ipcMain.handle("kauneonga:login", async (_evt, { email, password }) => {
    if (!API_BASE) {
      return { ok: false, error: "Helper is not configured with a backend (KAUNEONGA_API_URL not set)." };
    }
    try {
      const res = await fetch(`${API_BASE}${LOGIN_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, type: "agent" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `Sign-in failed (${res.status})` };
      }
      const data = await res.json();
      saveSession({ accessToken: data.accessToken, refreshToken: data.refreshToken, email });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeFetchError(err) };
    }
  });

  ipcMain.handle("kauneonga:logout", async () => {
    const session = loadSession();
    if (API_BASE && session) {
      try {
        await fetch(`${API_BASE}${LOGOUT_PATH}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
      } catch (_) {
        /* best-effort server-side invalidation */
      }
    }
    clearSession();
    return { ok: true };
  });

  // Collect real OS facts, merged with the signed-in agent's policy (identity,
  // validation, workspace, mfa, approved-device overrides, etc.) from the backend.
  ipcMain.handle("kauneonga:get-facts", async () => {
    return collectFacts(await fetchPolicy());
  });

  // Slow scans (OS updates + SSD flag), fetched lazily after first paint.
  ipcMain.handle("kauneonga:get-deferred", () => detectDeferred());

  // POST the health report to the backend. No-ops when no backend is configured.
  ipcMain.handle("kauneonga:send-report", async (_evt, facts) => {
    if (!API_BASE) {
      return { ok: true, skipped: true, reason: "No KAUNEONGA_API_URL configured" };
    }
    try {
      const res = await apiFetch(REPORT_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(facts),
      });
      if (!res) return { ok: false, error: "Not signed in" };
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, error: describeFetchError(err) };
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
