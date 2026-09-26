import express from "express";
import { config } from "./config.js";
import { one, all, run, pool } from "./db.js";
import {
  ApiError,
  ROLES,
  DEFAULT_DEV_MESSAGE,
  fail,
  str,
  hashPassword,
  verifyPassword,
  needsRehash,
  settings,
  setSetting,
  developerMode,
  developerMessage,
  publicUser,
  appBlock,
  failBlock,
  appPayload,
  issueToken,
  bearer,
  sha256,
  auth,
  requireAdmin,
  tooManyFailures,
  recordFailure,
  audit,
} from "./lib.js";

const USERNAME_RE = /^[A-Za-z0-9_.]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENDPOINT_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;

function userRow(u) {
  return {
    ...publicUser(u),
    isLocked: Number(u.is_locked) === 1,
    lockReason: u.lock_reason,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    lastLoginIp: u.last_login_ip,
  };
}

function settingsView(s) {
  return {
    developerMode: developerMode(s),
    developerMessage: s.developer_message ?? "",
    registrationOpen: (s.registration_open ?? "1") === "1",
    relayEndpoint: s.relay_endpoint ?? "",
    relayPsk: s.relay_psk ?? "",
  };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind Caddy on the same host: take the client address from X-Forwarded-For.
  app.set("trust proxy", "loopback");

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });

  // ---------------------------------------------------------------- API
  const api = express.Router();

  api.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Max-Age", "600");
    }
    res.set("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  api.use(express.json({ limit: "16kb" }));

  api.get("/health", async (req, res) => {
    await one("SELECT 1 AS ok");
    res.json({ ok: true });
  });

  api.get("/status", async (req, res) => {
    const s = await settings();
    const dev = developerMode(s);
    res.json({
      ok: true,
      developerMode: dev,
      message: dev ? developerMessage(s) : "",
      registrationOpen: (s.registration_open ?? "1") === "1",
    });
  });

  api.post("/auth/login", async (req, res) => {
    const body = req.body ?? {};
    const login = str(body, "login", 191);
    const password = typeof body.password === "string" ? body.password : "";
    const device = str(body, "device", 100);
    if (!login || !password) fail("Nhập tên đăng nhập (hoặc email) và mật khẩu.", 422, "missing_fields");

    const ip = req.ip;
    if (await tooManyFailures(ip)) {
      fail("Đăng nhập sai quá nhiều lần, vui lòng thử lại sau ít phút.", 429, "rate_limited");
    }

    const user = await one("SELECT * FROM gsb_users WHERE username = ? OR email = ? LIMIT 1", [
      login,
      login.toLowerCase(),
    ]);
    if (!(await verifyPassword(password, user?.password_hash))) {
      await recordFailure(ip);
      fail("Sai tên đăng nhập hoặc mật khẩu.", 401, "invalid_credentials");
    }
    if (needsRehash(user.password_hash)) {
      await run("UPDATE gsb_users SET password_hash = ? WHERE id = ?", [await hashPassword(password), user.id]);
    }

    const s = await settings();
    const block = appBlock(user, s);
    if (block) failBlock(block);

    await run("UPDATE gsb_users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?", [ip, user.id]);
    res.json({ ok: true, ...(await issueToken(user.id, device, ip)), ...appPayload(user, s) });
  });

  api.post("/auth/register", async (req, res) => {
    const body = req.body ?? {};
    const s = await settings();
    if ((s.registration_open ?? "1") !== "1") {
      fail("Hiện đang tạm dừng đăng ký tài khoản mới.", 403, "registration_closed");
    }

    const username = str(body, "username", 64);
    const email = str(body, "email", 191).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = str(body, "displayName", 64);
    const device = str(body, "device", 100);

    if (!USERNAME_RE.test(username)) {
      fail("Tên đăng nhập 3-32 ký tự, chỉ gồm chữ, số, dấu chấm và gạch dưới.", 422, "invalid_username");
    }
    if (!EMAIL_RE.test(email)) fail("Email không hợp lệ.", 422, "invalid_email");
    if (password.length < 8 || password.length > 200) fail("Mật khẩu tối thiểu 8 ký tự.", 422, "invalid_password");

    const ip = req.ip;
    const recent = await one(
      `SELECT COUNT(*) AS n FROM gsb_audit_log
        WHERE action = 'register' AND ip = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      [ip],
    );
    if (Number(recent.n) >= config.registerPerHour) {
      fail("Bạn đăng ký quá nhiều tài khoản, vui lòng thử lại sau.", 429, "rate_limited");
    }

    const dup = await one(
      "SELECT username = ? AS same_name FROM gsb_users WHERE username = ? OR email = ? LIMIT 1",
      [username, username, email],
    );
    if (dup) {
      const sameName = Number(dup.same_name) === 1;
      fail(sameName ? "Tên đăng nhập đã tồn tại." : "Email đã được dùng.", 409, sameName ? "username_taken" : "email_taken");
    }

    let id;
    try {
      const r = await run(
        "INSERT INTO gsb_users (username, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'user')",
        [username, email, await hashPassword(password), displayName],
      );
      id = r.insertId;
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") fail("Tên đăng nhập hoặc email đã tồn tại.", 409, "duplicate");
      throw e;
    }
    await audit(id, "register", username, "", ip);

    const user = await one("SELECT * FROM gsb_users WHERE id = ?", [id]);
    // The account exists either way; only the session depends on whether the app is open to it.
    const block = appBlock(user, s);
    if (block) {
      return res.status(201).json({ ok: true, created: true, blocked: { code: block.code, message: block.message } });
    }
    await run("UPDATE gsb_users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?", [ip, id]);
    res.status(201).json({ ok: true, created: true, ...(await issueToken(id, device, ip)), ...appPayload(user, s) });
  });

  // Asked by the app on start and every minute while open, so turning developer mode on (or
  // locking an account) reaches clients that are already signed in.
  api.get("/auth/me", async (req, res) => {
    const user = await auth(req);
    const s = await settings();
    const block = appBlock(user, s);
    if (block) failBlock(block);
    res.json({ ok: true, ...appPayload(user, s) });
  });

  api.post("/auth/logout", async (req, res) => {
    const token = bearer(req);
    if (token) await run("DELETE FROM gsb_sessions WHERE token_hash = ?", [sha256(token)]);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- admin
  const admin = express.Router();
  admin.use(async (req, res, next) => {
    const u = await auth(req);
    requireAdmin(u);
    req.admin = u;
    next();
  });

  admin.get("/settings", async (req, res) => {
    res.json({ ok: true, settings: settingsView(await settings()) });
  });

  admin.post("/settings", async (req, res) => {
    const body = req.body ?? {};
    const has = (k) => Object.hasOwn(body, k);
    const changes = {};

    if (has("developerMode")) changes.developer_mode = body.developerMode ? "1" : "0";
    if (has("registrationOpen")) changes.registration_open = body.registrationOpen ? "1" : "0";
    if (has("developerMessage")) changes.developer_message = str(body, "developerMessage", 300) || DEFAULT_DEV_MESSAGE;
    if (has("relayEndpoint")) {
      const ep = str(body, "relayEndpoint", 100);
      if (ep && !ENDPOINT_RE.test(ep)) {
        fail("Endpoint phải có dạng host:port, ví dụ 74.81.54.113:51820.", 422, "invalid_endpoint");
      }
      changes.relay_endpoint = ep;
    }
    if (has("relayPsk")) {
      const psk = str(body, "relayPsk", 200);
      if (psk && psk.length < 16) fail("PSK tối thiểu 16 ký tự.", 422, "invalid_psk");
      changes.relay_psk = psk;
    }
    if (!Object.keys(changes).length) fail("Không có thay đổi nào.", 422, "no_changes");

    const before = await settings();
    for (const [key, value] of Object.entries(changes)) {
      await setSetting(key, value);
      if (before[key] !== value) {
        // The PSK is a secret: the log records that it changed, never the value.
        await audit(req.admin.id, "setting", key, key === "relay_psk" ? "(đã đổi)" : value, req.ip);
      }
    }
    res.json({ ok: true, settings: settingsView(await settings()) });
  });

  admin.get("/users", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const role = String(req.query.role ?? "");
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const per = 50;

    const where = [];
    const args = [];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push("(username LIKE ? OR email LIKE ? OR display_name LIKE ?)");
      args.push(like, like, like);
    }
    if (ROLES.includes(role)) {
      where.push("role = ?");
      args.push(role);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { n: total } = await one(`SELECT COUNT(*) AS n FROM gsb_users ${sqlWhere}`, args);
    const users = await all(
      `SELECT * FROM gsb_users ${sqlWhere} ORDER BY id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`,
      args,
    );
    const roleCounts = Object.fromEntries(ROLES.map((r) => [r, 0]));
    for (const r of await all("SELECT role, COUNT(*) AS n FROM gsb_users GROUP BY role")) {
      roleCounts[r.role] = Number(r.n);
    }
    res.json({ ok: true, users: users.map(userRow), total: Number(total), page, perPage: per, roleCounts });
  });

  admin.post("/users", async (req, res) => {
    const body = req.body ?? {};
    const id = Number.parseInt(body.id, 10) || 0;
    const target = await one("SELECT * FROM gsb_users WHERE id = ?", [id]);
    if (!target) fail("Không tìm thấy tài khoản.", 404, "not_found");

    // An admin cannot demote or lock themselves: with a single admin that locks everybody out of
    // this panel, and there is no other way back in than the CLI.
    const self = Number(target.id) === Number(req.admin.id);
    const actor = req.admin.id;

    if (Object.hasOwn(body, "role")) {
      const role = String(body.role);
      if (!ROLES.includes(role)) fail("Role không hợp lệ.", 422, "invalid_role");
      if (self && role !== "admin") fail("Không thể tự hạ quyền admin của chính mình.", 422, "self_demote");
      if (role !== target.role) {
        await run("UPDATE gsb_users SET role = ? WHERE id = ?", [role, id]);
        await audit(actor, "role", target.username, `${target.role} -> ${role}`, req.ip);
      }
    }

    if (Object.hasOwn(body, "isLocked")) {
      const lock = Boolean(body.isLocked);
      if (self && lock) fail("Không thể tự khóa tài khoản của chính mình.", 422, "self_lock");
      const reason = lock ? str(body, "lockReason", 255) : "";
      await run("UPDATE gsb_users SET is_locked = ?, lock_reason = ? WHERE id = ?", [lock ? 1 : 0, reason, id]);
      if (lock) await run("DELETE FROM gsb_sessions WHERE user_id = ?", [id]);
      if (lock !== (Number(target.is_locked) === 1)) {
        await audit(actor, lock ? "lock" : "unlock", target.username, reason, req.ip);
      }
    }

    if (body.revokeSessions) {
      await run("DELETE FROM gsb_sessions WHERE user_id = ?", [id]);
      await audit(actor, "revoke_sessions", target.username, "", req.ip);
    }

    res.json({ ok: true, user: userRow(await one("SELECT * FROM gsb_users WHERE id = ?", [id])) });
  });

  admin.get("/audit", async (req, res) => {
    const rows = await all(
      `SELECT a.id, a.action, a.target, a.detail, a.ip, a.created_at, u.username AS actor
         FROM gsb_audit_log a LEFT JOIN gsb_users u ON u.id = a.actor_id
        ORDER BY a.id DESC LIMIT 100`,
    );
    res.json({
      ok: true,
      entries: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        target: r.target,
        detail: r.detail,
        ip: r.ip,
        actor: r.actor,
        createdAt: r.created_at,
      })),
    });
  });

  api.use("/admin", admin);

  api.use((req, res) => {
    res.status(404).json({ ok: false, error: "Không tìm thấy.", code: "not_found" });
  });

  api.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...err.extra });
    }
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ ok: false, error: "Dữ liệu gửi lên không phải JSON hợp lệ.", code: "bad_request" });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ ok: false, error: "Dữ liệu gửi lên quá lớn.", code: "too_large" });
    }
    console.error(err);
    const db = typeof err.code === "string" && /^(ER_|ECONN|ETIMEDOUT|PROTOCOL_)/.test(err.code);
    res.status(500).json({
      ok: false,
      error: db ? "Không kết nối được cơ sở dữ liệu." : "Lỗi máy chủ.",
      code: db ? "db_unavailable" : "server_error",
    });
  });

  app.use("/api", api);
  app.use((req, res) => res.status(404).json({ ok: false, error: "Không tìm thấy.", code: "not_found" }));

  return app;
}

export async function cleanupExpired() {
  await run("DELETE FROM gsb_sessions WHERE expires_at < NOW()");
  await run("DELETE FROM gsb_login_attempts WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");
}

export { pool };
