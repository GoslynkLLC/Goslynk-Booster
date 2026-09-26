const env = process.env;

function int(name, fallback) {
  const v = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: int("PORT", 8787),
  host: env.HOST || "127.0.0.1",
  db: {
    host: env.DB_HOST || "127.0.0.1",
    port: int("DB_PORT", 3306),
    database: env.DB_NAME || "",
    user: env.DB_USER || "",
    password: env.DB_PASS || "",
  },
  // The desktop app's webview origins: tauri://localhost on macOS, http(s)://tauri.localhost on
  // Windows, and the Vite dev server. The admin panel is served from this API's own origin.
  allowedOrigins: (
    env.ALLOWED_ORIGINS ||
    "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tokenDays: int("TOKEN_DAYS", 30),
  maxFailures: int("MAX_FAILURES", 10),
  failureWindowMin: int("FAILURE_WINDOW_MIN", 15),
  registerPerHour: int("REGISTER_PER_HOUR", 5),
  bcryptCost: int("BCRYPT_COST", 12),
};
