import express from "express";
import { config } from "./config.js";
import { one, all, run, pool, transaction } from "./db.js";
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
  USER_SELECT,
  endExtraSessions,
} from "./lib.js";

const USERNAME_RE = /^[A-Za-z0-9_.]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENDPOINT_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const CODE_RE = /^[A-Z0-9_.]{3,64}$/;
const HWID_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REDEEM_MAX_MISSES = 10;
const REDEEM_MISS_WINDOW_MIN = 15;
const MAX_VIP_DAYS = 3650;
/** What each redeem code reward_type adds days to. */
const REWARDS = {
  vip_days: { column: "vip_until", label: "VIP" },
  vip_plus_days: { column: "vip_plus_until", label: "VIP+" },
};

const toInt = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** A YYYY-MM-DD from the admin panel as the end of that day, null for "never", or a 422. */
function parseExpiry(value) {
  if (value === null || value === "") return null;
  const d = typeof value === "string" ? value.trim() : "";
  const t = new Date(`${d}T00:00:00Z`);
  if (!DATE_RE.test(d) || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) {
    fail("Ngày hết hạn không hợp lệ.", 422, "invalid_expires_at");
  }
  return `${d} 23:59:59`;
}

function userRow(u) {
  return {
    ...publicUser(u),
    // The stored role, which is what the admin edits; publicUser reports an active VIP as "vip".
    role: u.role,
    vipUntil: u.vip_until ?? null,
    vipPlusUntil: u.vip_plus_until ?? null,
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

  const api = express.Router();

  api.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token");
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

    const user = await one(`${USER_SELECT} WHERE username = ? OR email = ? LIMIT 1`, [
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
    const { sessionId: _, ...session } = await issueToken(user.id, device, ip);
    const ended = await endExtraSessions(user);
    if (ended) await audit(user.id, "signed_out_elsewhere", user.username, `${ended} thiết bị cũ`, ip);
    res.json({ ok: true, ...session, ...appPayload(user, s) });
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
    const { sessionId: _, ...session } = await issueToken(id, device, ip);
    res.status(201).json({ ok: true, created: true, ...session, ...appPayload(user, s) });
  });

  // Asked by the app on start and every minute while open, so turning developer mode on (or
  // locking an account) reaches clients that are already signed in.
  api.get("/auth/me", async (req, res) => {
    const user = await auth(req);
    const s = await settings();
    const block = appBlock(user, s);
    if (block) failBlock(block);
    // Catches accounts whose device limit dropped (VIP+ ran out, role lowered) since they signed in.
    await endExtraSessions(user);
    res.json({ ok: true, ...appPayload(user, s) });
  });

  api.post("/auth/logout", async (req, res) => {
    const token = bearer(req);
    if (token) await run("DELETE FROM gsb_sessions WHERE token_hash = ?", [sha256(token)]);
    res.json({ ok: true });
  });

  /** The signed-in user and settings, or the same refusal /auth/me would give. */
  async function activeUser(req) {
    const user = await auth(req);
    const s = await settings();
    const block = appBlock(user, s);
    if (block) failBlock(block);
    return { user, s };
  }

  // Shares the login failure counter, so it cannot be used to guess the password either.
  async function checkPassword(req, user, password) {
    if (await tooManyFailures(req.ip)) {
      fail("Nhập sai mật khẩu quá nhiều lần, vui lòng thử lại sau ít phút.", 429, "rate_limited");
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      await recordFailure(req.ip);
      fail("Mật khẩu hiện tại không đúng.", 403, "wrong_password");
    }
  }

  // Changing the email needs the current password; the display name does not.
  api.post("/auth/profile", async (req, res) => {
    const { user, s } = await activeUser(req);
    const body = req.body ?? {};
    const displayName = body.displayName === undefined ? user.display_name : str(body, "displayName", 64);
    const email = body.email === undefined ? user.email : str(body, "email", 191).toLowerCase();

    const changes = [];
    if (displayName !== user.display_name) changes.push("tên hiển thị");
    if (email !== user.email) {
      if (!EMAIL_RE.test(email)) fail("Email không hợp lệ.", 422, "invalid_email");
      await checkPassword(req, user, typeof body.currentPassword === "string" ? body.currentPassword : "");
      changes.push("email");
    }
    if (changes.length) {
      try {
        await run("UPDATE gsb_users SET display_name = ?, email = ? WHERE id = ?", [displayName, email, user.id]);
      } catch (e) {
        if (e.code === "ER_DUP_ENTRY") fail("Email đã được dùng.", 409, "email_taken");
        throw e;
      }
      await audit(user.id, "profile", user.username, changes.join(", "), req.ip);
    }
    const fresh = await one(`${USER_SELECT} WHERE id = ?`, [user.id]);
    res.json({ ok: true, ...appPayload(fresh, s) });
  });

  api.post("/auth/password", async (req, res) => {
    const { user } = await activeUser(req);
    const body = req.body ?? {};
    const next = typeof body.newPassword === "string" ? body.newPassword : "";
    if (next.length < 8 || next.length > 200) fail("Mật khẩu mới tối thiểu 8 ký tự.", 422, "invalid_password");
    await checkPassword(req, user, typeof body.currentPassword === "string" ? body.currentPassword : "");

    await run("UPDATE gsb_users SET password_hash = ? WHERE id = ?", [await hashPassword(next), user.id]);
    const r = await run("DELETE FROM gsb_sessions WHERE user_id = ? AND id <> ?", [user.id, user.session_id]);
    await audit(user.id, "password", user.username, `${r.affectedRows} thiết bị khác bị đăng xuất`, req.ip);
    res.json({ ok: true, signedOut: r.affectedRows });
  });

  api.get("/auth/sessions", async (req, res) => {
    const { user } = await activeUser(req);
    const rows = await all(
      `SELECT id, device_name, ip, created_at, last_seen_at FROM gsb_sessions
        WHERE user_id = ? AND expires_at > NOW() ORDER BY COALESCE(last_seen_at, created_at) DESC`,
      [user.id],
    );
    res.json({
      ok: true,
      sessions: rows.map((r) => ({
        id: Number(r.id),
        device: r.device_name,
        ip: r.ip,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        current: Number(r.id) === Number(user.session_id),
      })),
    });
  });

  api.post("/auth/sessions/revoke-others", async (req, res) => {
    const { user } = await activeUser(req);
    const r = await run("DELETE FROM gsb_sessions WHERE user_id = ? AND id <> ?", [user.id, user.session_id]);
    await audit(user.id, "revoke_sessions", user.username, `${r.affectedRows} thiết bị (tự đăng xuất)`, req.ip);
    res.json({ ok: true, signedOut: r.affectedRows });
  });

  // Each code pays out once per account and once per machine. The machine id is a hash the app
  // computes, so it only slows down one person farming a code with many accounts; the per-account
  // limit is the one the server can actually enforce.
  api.post("/redeem", async (req, res) => {
    const user = await auth(req);
    const block = appBlock(user, await settings());
    if (block) failBlock(block);

    const code = str(req.body, "code", 64).toUpperCase();
    const hwid = str(req.body, "hwidHash", 64).toLowerCase();
    if (!code) fail("Vui lòng nhập mã quà tặng.", 422, "missing_code");
    if (!HWID_RE.test(hwid)) {
      fail("Không đọc được mã thiết bị. Hãy cập nhật app lên bản mới nhất rồi thử lại.", 422, "invalid_hwid");
    }

    const ip = req.ip;
    const misses = await one(
      `SELECT COUNT(*) AS n FROM gsb_audit_log
        WHERE action = 'redeem_invalid' AND (ip = ? OR actor_id = ?)
          AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [ip, user.id, REDEEM_MISS_WINDOW_MIN],
    );
    if (Number(misses.n) >= REDEEM_MAX_MISSES) {
      fail("Nhập sai mã quá nhiều lần, vui lòng thử lại sau ít phút.", 429, "rate_limited");
    }
    if (!CODE_RE.test(code)) {
      await audit(user.id, "redeem_invalid", code, "", ip);
      fail("Mã quà tặng không hợp lệ hoặc không tồn tại.", 404, "invalid_code");
    }

    const result = await transaction(async (conn) => {
      // The row lock serialises redeems of one code, so the max_uses check cannot be raced.
      const [[c]] = await conn.execute(
        `SELECT id, reward_type, reward_value, max_uses, used_count, is_active,
                (expires_at IS NOT NULL AND expires_at < NOW()) AS expired
           FROM gsb_redeem_codes WHERE code = ? FOR UPDATE`,
        [code],
      );
      if (!c) return { miss: true };
      if (Number(c.is_active) !== 1) fail("Mã quà tặng này đã bị vô hiệu hóa.", 410, "code_disabled");
      if (Number(c.expired) === 1) fail("Mã quà tặng này đã hết hạn sử dụng.", 410, "code_expired");
      const reward = REWARDS[c.reward_type];
      if (!reward) fail("Loại quà của mã này chưa được hỗ trợ.", 422, "unsupported_reward");
      if (c.max_uses > 0 && c.used_count >= c.max_uses) {
        fail("Mã quà tặng này đã hết lượt sử dụng.", 410, "code_limit_reached");
      }

      const [[prev]] = await conn.execute(
        "SELECT user_id = ? AS mine FROM gsb_hwid_redeems WHERE code_id = ? AND (user_id = ? OR hwid_hash = ?) LIMIT 1",
        [user.id, c.id, user.id, hwid],
      );
      if (prev) {
        fail(
          Number(prev.mine) === 1
            ? "Tài khoản của bạn đã nhận quà từ mã này rồi."
            : "Máy này đã nhận quà từ mã này bằng một tài khoản khác.",
          409,
          "already_redeemed",
        );
      }

      await conn.execute("INSERT INTO gsb_hwid_redeems (code_id, user_id, hwid_hash, ip) VALUES (?, ?, ?, ?)", [
        c.id,
        user.id,
        hwid,
        ip,
      ]);
      await conn.execute("UPDATE gsb_redeem_codes SET used_count = used_count + 1 WHERE id = ?", [c.id]);
      // Unexpired days are extended from their end, expired ones from now.
      const col = reward.column;
      await conn.execute(
        `UPDATE gsb_users SET ${col} = DATE_ADD(GREATEST(COALESCE(${col}, NOW()), NOW()), INTERVAL ? DAY) WHERE id = ?`,
        [c.reward_value, user.id],
      );
      const [[u]] = await conn.execute(`SELECT ${col} AS until FROM gsb_users WHERE id = ?`, [user.id]);
      return { type: c.reward_type, label: reward.label, days: Number(c.reward_value), until: u.until };
    });

    if (result.miss) {
      await audit(user.id, "redeem_invalid", code, "", ip);
      fail("Mã quà tặng không hợp lệ hoặc không tồn tại.", 404, "invalid_code");
    }
    await audit(user.id, "redeem_code", code, `+${result.days} ${result.type} -> ${result.until}`, ip);
    res.json({
      ok: true,
      message: `Nhận quà thành công! Bạn được cộng ${result.days} ngày ${result.label} (đến ${result.until}).`,
      rewardType: result.type,
      rewardValue: result.days,
      until: result.until,
    });
  });

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

  admin.get("/redeems", async (req, res) => {
    const rows = await all(
      `SELECT id, code, reward_type, reward_value, max_uses, used_count, expires_at, is_active, created_at,
              (expires_at IS NOT NULL AND expires_at < NOW()) AS expired
         FROM gsb_redeem_codes
        ORDER BY is_active DESC, expired ASC, id DESC`,
    );
    res.json({
      ok: true,
      codes: rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        rewardType: r.reward_type,
        rewardValue: Number(r.reward_value),
        maxUses: Number(r.max_uses),
        usedCount: Number(r.used_count),
        expiresAt: r.expires_at,
        isActive: Number(r.is_active) === 1,
        expired: Number(r.expired) === 1,
        createdAt: r.created_at,
      })),
    });
  });

  admin.post("/redeems", async (req, res) => {
    const body = req.body ?? {};
    const code = str(body, "code", 64).toUpperCase();
    if (!CODE_RE.test(code)) {
      fail("Mã code 3-64 ký tự, chỉ gồm chữ in hoa, số, dấu chấm và gạch dưới.", 422, "invalid_code");
    }
    const rewardType = body.rewardType === "vip_plus_days" ? "vip_plus_days" : "vip_days";
    const rewardValue = Math.min(MAX_VIP_DAYS, Math.max(1, toInt(body.rewardValue, 7)));
    const maxUses = Math.max(0, toInt(body.maxUses, 0));
    const expiresAt = parseExpiry(body.expiresAt ?? null);
    if (expiresAt && (await one("SELECT ? < NOW() AS past", [expiresAt])).past) {
      fail("Ngày hết hạn không được ở trong quá khứ.", 422, "past_expires_at");
    }

    try {
      await run(
        "INSERT INTO gsb_redeem_codes (code, reward_type, reward_value, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)",
        [code, rewardType, rewardValue, maxUses, expiresAt],
      );
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") fail("Mã code này đã tồn tại.", 409, "code_exists");
      throw e;
    }
    await audit(req.admin.id, "create_redeem_code", code, `+${rewardValue} ${rewardType}, max=${maxUses}`, req.ip);
    res.status(201).json({ ok: true, message: "Đã tạo mã quà tặng." });
  });

  // Fields left out of the body keep their current value.
  admin.put("/redeems/:id", async (req, res) => {
    const id = toInt(req.params.id, 0);
    const existing = id > 0 ? await one("SELECT * FROM gsb_redeem_codes WHERE id = ?", [id]) : null;
    if (!existing) fail("Không tìm thấy mã quà tặng này.", 404, "not_found");

    const body = req.body ?? {};
    const rewardValue = Math.min(MAX_VIP_DAYS, Math.max(1, toInt(body.rewardValue, existing.reward_value)));
    const maxUses = Math.max(0, toInt(body.maxUses, existing.max_uses));
    const expiresAt = body.expiresAt === undefined ? existing.expires_at : parseExpiry(body.expiresAt);
    const isActive = body.isActive === undefined ? Number(existing.is_active) : body.isActive ? 1 : 0;

    await run("UPDATE gsb_redeem_codes SET reward_value = ?, max_uses = ?, expires_at = ?, is_active = ? WHERE id = ?", [
      rewardValue,
      maxUses,
      expiresAt,
      isActive,
      id,
    ]);
    await audit(
      req.admin.id,
      "update_redeem_code",
      existing.code,
      `+${rewardValue} ${existing.reward_type}, max=${maxUses}, exp=${expiresAt ?? "never"}, active=${isActive}`,
      req.ip,
    );
    res.json({ ok: true, message: "Đã lưu mã quà tặng." });
  });

  // Toggles the code on and off; redeem history keeps pointing at it, so it is never deleted.
  admin.delete("/redeems/:id", async (req, res) => {
    const id = toInt(req.params.id, 0);
    const existing = id > 0 ? await one("SELECT code, is_active FROM gsb_redeem_codes WHERE id = ?", [id]) : null;
    if (!existing) fail("Không tìm thấy mã quà tặng này.", 404, "not_found");

    const next = Number(existing.is_active) === 1 ? 0 : 1;
    await run("UPDATE gsb_redeem_codes SET is_active = ? WHERE id = ?", [next, id]);
    await audit(req.admin.id, next ? "enable_redeem_code" : "disable_redeem_code", existing.code, "", req.ip);
    res.json({ ok: true, message: next ? "Đã bật lại mã." : "Đã khóa mã." });
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
