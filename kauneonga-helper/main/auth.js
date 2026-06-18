// auth.js — stores the Liberty sign-in session for the MAIN process.
//
// The Helper authenticates once against Liberty's JWT auth (POST
// /api/v2/auth/login) and keeps { accessToken, refreshToken, email } on disk,
// encrypted with Electron's safeStorage (Keychain on macOS, DPAPI on Windows,
// libsecret on Linux). main.js sends accessToken as a Bearer header when
// fetching policy data and posting health reports, and silently refreshes it
// via refreshToken on expiry (see apiFetch in main.js).

const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

const SESSION_FILE = "kauneonga-session.bin";

function sessionFilePath() {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

function loadSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const enc = fs.readFileSync(sessionFilePath());
    return JSON.parse(safeStorage.decryptString(enc));
  } catch (_) {
    return null;
  }
}

function saveSession(session) {
  const enc = safeStorage.encryptString(JSON.stringify(session));
  fs.writeFileSync(sessionFilePath(), enc);
}

function clearSession() {
  try {
    fs.unlinkSync(sessionFilePath());
  } catch (_) {
    /* nothing to remove */
  }
}

module.exports = { loadSession, saveSession, clearSession };
