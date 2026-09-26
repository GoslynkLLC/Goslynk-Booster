function isTauri() {
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

export function apiLogin(username, password) {
  return invoke("login", { username, password });
}

export function apiRegister(username, password, displayName) {
  return invoke("register", { username, password, displayName });
}

export function apiListGames() {
  return invoke("list_games");
}

export function apiDefaultRelay() {
  return invoke("default_relay");
}

export function apiConnect(args) {
  return invoke("connect", { args });
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
