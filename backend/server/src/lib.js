import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { one, all, run } from "./db.js";

/** Lowest to highest. */
export const ROLES = ["user", "vip", "vip_plus", "developer", "admin"];
export const DEV_ROLES = ["developer", "admin"];
export const BOOST_ROLES = ["vip", "vip_plus", "developer", "admin"];
/** Devices a role may be signed in on at once; roles not listed have no limit. */
export const DEVICE_LIMIT = { user: 1, vip: 1, vip_plus: 2 };
export const DEFAULT_DEV_MESSAGE = "Ứng dụng đang bảo trì, vui lòng quay lại sau.";

export class ApiError extends Error {
  constructor(message, status = 400, code = "bad_request", extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const fail = (message, status, code, extra) => {
  throw new ApiError(message, status, code, extra);
};

export function str(body, key, max = 255) {
  const v = body?.[key];
  return typeof v === "string" ? [...v.trim()].slice(0, max).join("") : "";
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Hashes written by PHP's password_hash() use the $2y$ prefix; bcrypt treats it as $2b$.
const normalizeHash = (h) => (h.startsWith("$2y$") ? "$2b$" + h.slice(4) : h);

// Compared against when the account does not exist, so a miss costs as long as a wrong password
// and response time does not reveal which usernames are registered. Same cost as real hashes, or
// the timing difference gives it away anyway.
const DUMMY_HASH = bcrypt.hashSync("goslynk-dummy-password", config.bcryptCost);

export const hashPassword = (pw) => bcrypt.hash(pw, config.bcryptCost);

export async function verifyPassword(pw, hash) {
  if (!hash) {
    await bcrypt.compare(pw, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(pw, normalizeHash(hash));
}

export function needsRehash(hash) {
  try {
    return bcrypt.getRounds(normalizeHash(hash)) < config.bcryptCost;
  } catch {
    return true;
  }
}

export async function settings() {
  const rows = await all("SELECT setting_key, setting_value FROM gsb_settings");
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
}

export async function setSetting(key, value) {
  await run(
    `INSERT INTO gsb_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value],
  );
}

export const developerMode = (s) => (s.developer_mode ?? "0") === "1";
export const developerMessage = (s) => s.developer_message || DEFAULT_DEV_MESSAGE;

/** Selects a user row with the `*_active` flags publicUser needs; compared in SQL to stay in the DB's clock. */
export const USER_SELECT =
  "SELECT *, (vip_until > NOW()) AS vip_active, (vip_plus_until > NOW()) AS vip_plus_active FROM gsb_users";

/** The role an account has right now: its stored role, raised by unexpired VIP+ or VIP days. */
export function effectiveRole(u) {
  const timed = Number(u.vip_plus_active) === 1 ? "vip_plus" : Number(u.vip_active) === 1 ? "vip" : "user";
  return ROLES.indexOf(timed) > ROLES.indexOf(u.role) ? timed : u.role;
}

export function publicUser(u) {
  const role = effectiveRole(u);
  return {
    id: Number(u.id),
    username: u.username,
    email: u.email,
    displayName: u.display_name || u.username,
    role,
    vipUntil: Number(u.vip_active) === 1 ? u.vip_until : null,
    vipPlusUntil: Number(u.vip_plus_active) === 1 ? u.vip_plus_until : null,
    canBoost: BOOST_ROLES.includes(role),
    deviceLimit: DEVICE_LIMIT[role] ?? null,
    createdAt: u.created_at,
  };
}

/** Why this account may not use the app right now, or null when it may. */
export function appBlock(u, s) {
  if (Number(u.is_locked) === 1) {
    const reason = u.lock_reason ? `: ${u.lock_reason}` : ".";
    return { code: "locked", message: `Tài khoản đã bị khóa${reason}`, status: 403 };
  }
  if (developerMode(s) && !DEV_ROLES.includes(effectiveRole(u))) {
    return { code: "developer_mode", message: developerMessage(s), status: 403 };
  }
  return null;
}

export const failBlock = (b) => fail(b.message, b.status, b.code);

/**
 * What a signed-in client needs to connect. The PSK only ever leaves the server here, and only
 * to accounts that may boost.
 */
export function appPayload(u, s) {
  const user = publicUser(u);
  return {
    user,
    developerMode: developerMode(s),
    relay: user.canBoost ? { endpoint: s.relay_endpoint || "", psk: s.relay_psk || "" } : { endpoint: "", psk: "" },
  };
}

export async function issueToken(userId, device, ip) {
  const token = crypto.randomBytes(32).toString("hex");
  const days = Math.max(1, config.tokenDays);
  const r = await run(
    `INSERT INTO gsb_sessions (user_id, token_hash, device_name, ip, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [userId, sha256(token), device.slice(0, 100), ip, days],
  );
  const row = await one("SELECT DATE_ADD(NOW(), INTERVAL ? DAY) AS exp", [days]);
  return { token, expiresAt: row.exp, sessionId: r.insertId };
}

/**
 * Keeps an account within its role's device limit (DEVICE_LIMIT): the newest sessions stay and
 * older ones end, so a new sign-in pushes out the oldest device. Ended sessions stay until the
 * hourly sweep so the pushed-out device can be told why.
 */
export async function endExtraSessions(u) {
  const limit = DEVICE_LIMIT[effectiveRole(u)];
  if (!limit) return 0;
  const live = await all("SELECT id FROM gsb_sessions WHERE user_id = ? AND expires_at > NOW() ORDER BY id DESC", [
    u.id,
  ]);
  if (live.length <= limit) return 0;
  const r = await run(
    `UPDATE gsb_sessions SET expires_at = NOW(), ended_reason = 'elsewhere'
      WHERE user_id = ? AND id < ? AND expires_at > NOW()`,
    [u.id, live[limit - 1].id],
  );
  return r.affectedRows;
}

export function bearer(req) {
  const h = (req.get("authorization") || "").trim();
  const m = /^Bearer\s+([0-9a-f]{64})$/i.exec(h);
  if (m) return m[1].toLowerCase();
  const alt = req.get("x-auth-token") || "";
  return /^[0-9a-f]{64}$/i.test(alt) ? alt.toLowerCase() : "";
}

/** The signed-in user (with `session_id`), or a 401. */
export async function auth(req) {
  const token = bearer(req);
  if (!token) fail("Chưa đăng nhập.", 401, "unauthorized");
  const u = await one(
    `SELECT u.*, s.id AS session_id, s.ended_reason, (s.expires_at <= NOW()) AS session_ended,
            (u.vip_until > NOW()) AS vip_active, (u.vip_plus_until > NOW()) AS vip_plus_active,
            (s.last_seen_at IS NULL OR s.last_seen_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS stale
       FROM gsb_sessions s JOIN gsb_users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [sha256(token)],
  );
  if (u && Number(u.session_ended) === 1 && u.ended_reason === "elsewhere") {
    fail(
      "Tài khoản vừa đăng nhập trên thiết bị khác nên thiết bị này bị đăng xuất. Thành viên và VIP dùng được 1 thiết bị, VIP+ dùng được 2.",
      401,
      "signed_in_elsewhere",
    );
  }
  if (!u || Number(u.session_ended) === 1) fail("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.", 401, "unauthorized");
  // Throttled: the app polls, and a write per poll is wasted work.
  if (Number(u.stale) === 1) {
    await run("UPDATE gsb_sessions SET last_seen_at = NOW(), ip = ? WHERE id = ?", [req.ip, u.session_id]);
  }
  return u;
}

export function requireAdmin(u) {
  if (u.role !== "admin") fail("Chỉ admin mới dùng được chức năng này.", 403, "forbidden");
  if (Number(u.is_locked) === 1) fail("Tài khoản đã bị khóa.", 403, "locked");
}

export async function tooManyFailures(ip) {
  await run("DELETE FROM gsb_login_attempts WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");
  const r = await one(
    "SELECT COUNT(*) AS n FROM gsb_login_attempts WHERE ip = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)",
    [ip, Math.max(1, config.failureWindowMin)],
  );
  return Number(r.n) >= Math.max(1, config.maxFailures);
}

export const recordFailure = (ip) => run("INSERT INTO gsb_login_attempts (ip) VALUES (?)", [ip]);

export function audit(actorId, action, target = "", detail = "", ip = "") {
  return run("INSERT INTO gsb_audit_log (actor_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)", [
    actorId,
    action,
    [...target].slice(0, 191).join(""),
    [...detail].slice(0, 500).join(""),
    ip,
  ]);
}
