// Accounts API. Override for local testing: VITE_API_BASE=http://127.0.0.1:8787/api npm run dev
const API_BASE = (import.meta.env.VITE_API_BASE || "https://74-81-54-113.sslip.io/api").replace(/\/+$/, "");

export function isTauri() {
  return typeof window !== "undefined" && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

async function invoke(cmd, args) {
  if (!isTauri()) {
    throw new Error(
      "App phải chạy trong cửa sổ Tauri, không mở trình duyệt.\nChạy: npm run dev  (trong thư mục gpb-app)",
    );
  }
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

// ------------------------------------------------------------------ accounts API

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The server refused this session for good: signed out, locked, or developer mode. */
export function isSessionRejected(e) {
  return e instanceof ApiError && (e.status === 401 || e.code === "locked" || e.code === "developer_mode");
}

let token = "";

export function setToken(t) {
  token = t || "";
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua) ? "Windows" : /Mac/i.test(ua) ? "macOS" : "PC";
  return `Goslynk Booster · ${os}`;
}

async function http(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Không kết nối được máy chủ Goslynk. Kiểm tra mạng rồi thử lại.", 0, "network");
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`Máy chủ trả về lỗi ${res.status}.`, res.status, "bad_response");
  }
  if (!data.ok) throw new ApiError(data.error || `Lỗi ${res.status}`, res.status, data.code);
  return data;
}

export function apiLogin(login, password) {
  return http("auth/login", { method: "POST", body: { login, password, device: deviceName() } });
}

export function apiRegister({ username, email, password, displayName }) {
  return http("auth/register", {
    method: "POST",
    body: { username, email, password, displayName, device: deviceName() },
  });
}

export function apiMe() {
  return http("auth/me");
}

export function apiLogout() {
  return http("auth/logout", { method: "POST" });
}

export const adminApi = {
  settings: () => http("admin/settings"),
  saveSettings: (patch) => http("admin/settings", { method: "POST", body: patch }),
  users: ({ q = "", role = "", page = 1 }) =>
    http(`admin/users?q=${encodeURIComponent(q)}&role=${encodeURIComponent(role)}&page=${page}`),
  updateUser: (id, patch) => http("admin/users", { method: "POST", body: { id, ...patch } }),
  audit: () => http("admin/audit"),
};

// ------------------------------------------------------------------ tunnel (Tauri)

export function apiListGames() {
  return invoke("list_games");
}

export function apiDefaultRelay() {
  return invoke("default_relay");
}

/** Boosts a game (or re-applies its regions); resolves to the boosted game ids. */
export function apiBoost(args) {
  return invoke("boost_game", { args });
}

export function apiUnboost(gameId) {
  return invoke("unboost_game", { gameId });
}

export function apiDisconnect() {
  return invoke("disconnect");
}

export function apiGetStatus() {
  return invoke("get_status");
}

export function errMsg(e) {
  if (typeof e === "string") return e;
  if (e?.message) return e.message;
  return String(e);
}

export async function apiRedeemCode(code) {
  let hwidHash;
  try {
    hwidHash = await invoke("get_hwid");
  } catch (e) {
    throw new ApiError(`Không đọc được mã thiết bị: ${errMsg(e)}`, 0, "hwid");
  }
  return http("redeem", { method: "POST", body: { code, hwidHash } });
}

export const adminRedeemApi = {
  list: () => http("admin/redeems"),
  create: (data) => http("admin/redeems", { method: "POST", body: data }),
  update: (id, data) => http(`admin/redeems/${id}`, { method: "PUT", body: data }),
  toggle: (id) => http(`admin/redeems/${id}`, { method: "DELETE" }),
};
