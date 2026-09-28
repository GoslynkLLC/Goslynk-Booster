// Needs a throwaway MySQL/MariaDB database; every gsb_* table in it is wiped.
//   TEST_DB_NAME=gsb_node_test TEST_DB_USER=gsb_node TEST_DB_PASS=... npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const env = process.env;
Object.assign(env, {
  DB_HOST: env.TEST_DB_HOST || "127.0.0.1",
  DB_PORT: env.TEST_DB_PORT || "3306",
  DB_NAME: env.TEST_DB_NAME || "gsb_node_test",
  DB_USER: env.TEST_DB_USER || "gsb_node",
  DB_PASS: env.TEST_DB_PASS || "gsb_node_pw",
  BCRYPT_COST: "4",
  REGISTER_PER_HOUR: "50",
  MAX_FAILURES: "3",
});

const { createApp, pool } = await import("../src/app.js");
const { migrate } = await import("../src/db.js");
const fs = await import("node:fs");
const mysql = (await import("mysql2/promise")).default;

const ALL_TABLES =
  "gsb_hwid_redeems, gsb_redeem_codes, gsb_sessions, gsb_login_attempts, gsb_audit_log, gsb_settings, gsb_users";

let server;
let base;

async function call(path, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const sql = (q, a) => pool.execute(q, a);

before(async () => {
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: +env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    multipleStatements: true,
  });
  await conn.query(`DROP TABLE IF EXISTS ${ALL_TABLES}`);
  await conn.query(fs.readFileSync(new URL("../../database.sql", import.meta.url), "utf8"));
  // A database created before redeem codes existed: migrate has to add the column itself.
  await conn.query("ALTER TABLE gsb_users DROP COLUMN vip_until");
  await conn.end();
  await migrate();
  await migrate();

  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.query(`DROP TABLE IF EXISTS ${ALL_TABLES}`);
  await pool.end();
});

const tokens = {};

test("register issues a session and hides nothing it should not", async () => {
  const r = await call("/api/auth/register", {
    method: "POST",
    body: { username: "alice", email: "Alice@Example.com", password: "password-1", displayName: "Alice" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, "user");
  assert.equal(r.data.user.email, "alice@example.com");
  assert.match(r.data.token, /^[0-9a-f]{64}$/);
  const [[row]] = await sql("SELECT token_hash FROM gsb_sessions LIMIT 1");
  assert.notEqual(row.token_hash, r.data.token, "only the hash is stored");
});

test("register validation and duplicates", async () => {
  const bad = await call("/api/auth/register", {
    method: "POST",
    body: { username: "a!", email: "x@y.z", password: "password-1" },
  });
  assert.equal(bad.data.code, "invalid_username");
  const short = await call("/api/auth/register", {
    method: "POST",
    body: { username: "shorty", email: "s@y.zz", password: "123" },
  });
  assert.equal(short.data.code, "invalid_password");
  const dup = await call("/api/auth/register", {
    method: "POST",
    body: { username: "alice", email: "other@example.com", password: "password-1" },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, "username_taken");
});

test("login by username or email, wrong password rejected", async () => {
  const bad = await call("/api/auth/login", { method: "POST", body: { login: "alice", password: "nope-nope" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.code, "invalid_credentials");
  const ok = await call("/api/auth/login", {
    method: "POST",
    body: { login: "ALICE@example.com", password: "password-1", device: "test" },
  });
  assert.equal(ok.status, 200);
  tokens.alice = ok.data.token;
  const me = await call("/api/auth/me", { token: tokens.alice });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, "alice");
});

test("roles and admin guard", async () => {
  for (const name of ["bob", "dev"]) {
    const r = await call("/api/auth/register", {
      method: "POST",
      body: { username: name, email: `${name}@example.com`, password: "password-1" },
    });
    tokens[name] = r.data.token;
  }
  const denied = await call("/api/admin/settings", { token: tokens.bob });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, "forbidden");

  await sql("UPDATE gsb_users SET role = 'admin' WHERE username = 'alice'");
  await sql("UPDATE gsb_users SET role = 'developer' WHERE username = 'dev'");
  await sql("UPDATE gsb_users SET role = 'vip' WHERE username = 'bob'");

  const list = await call("/api/admin/users?q=bo&role=", { token: tokens.alice });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.roleCounts, { user: 0, vip: 1, developer: 1, admin: 1 });
  assert.deepEqual(list.data.users.map((u) => u.username).sort(), ["bob"]);
});

test("developer mode blocks user and vip, not developer or admin", async () => {
  const set = await call("/api/admin/settings", {
    method: "POST",
    token: tokens.alice,
    body: { developerMode: true, developerMessage: "Đang bảo trì" },
  });
  assert.equal(set.status, 200);
  assert.equal(set.data.settings.developerMode, true);

  const status = await call("/api/status");
  assert.equal(status.data.developerMode, true);
  assert.equal(status.data.message, "Đang bảo trì");

  const vipMe = await call("/api/auth/me", { token: tokens.bob });
  assert.equal(vipMe.status, 403);
  assert.equal(vipMe.data.code, "developer_mode");
  assert.equal(vipMe.data.error, "Đang bảo trì");

  const vipLogin = await call("/api/auth/login", { method: "POST", body: { login: "bob", password: "password-1" } });
  assert.equal(vipLogin.data.code, "developer_mode");

  const devLogin = await call("/api/auth/login", { method: "POST", body: { login: "dev", password: "password-1" } });
  assert.equal(devLogin.status, 200);
  assert.equal(devLogin.data.developerMode, true);
  assert.equal((await call("/api/auth/me", { token: tokens.alice })).status, 200);

  const newcomer = await call("/api/auth/register", {
    method: "POST",
    body: { username: "carol", email: "carol@example.com", password: "password-1" },
  });
  assert.equal(newcomer.status, 201);
  assert.equal(newcomer.data.blocked.code, "developer_mode");
  assert.equal(newcomer.data.token, undefined);

  await call("/api/admin/settings", { method: "POST", token: tokens.alice, body: { developerMode: false } });
  assert.equal((await call("/api/auth/me", { token: tokens.bob })).status, 200);
});

test("relay settings reach signed-in clients; the PSK is not written to the audit log", async () => {
  const psk = "0123456789abcdef0123456789abcdef";
  const bad = await call("/api/admin/settings", {
    method: "POST",
    token: tokens.alice,
    body: { relayEndpoint: "not an endpoint" },
  });
  assert.equal(bad.data.code, "invalid_endpoint");
  await call("/api/admin/settings", {
    method: "POST",
    token: tokens.alice,
    body: { relayEndpoint: "74.81.54.113:51820", relayPsk: psk },
  });
  const me = await call("/api/auth/me", { token: tokens.bob });
  assert.deepEqual(me.data.relay, { endpoint: "74.81.54.113:51820", psk });
  const auditLog = await call("/api/admin/audit", { token: tokens.alice });
  assert.ok(!JSON.stringify(auditLog.data).includes(psk));
  assert.ok(auditLog.data.entries.some((e) => e.target === "relay_psk" && e.detail === "(đã đổi)"));
});

test("lock revokes sessions; admin cannot lock or demote self", async () => {
  const [[bob]] = await sql("SELECT id FROM gsb_users WHERE username = 'bob'");
  const [[alice]] = await sql("SELECT id FROM gsb_users WHERE username = 'alice'");
  const lock = await call("/api/admin/users", {
    method: "POST",
    token: tokens.alice,
    body: { id: bob.id, isLocked: true, lockReason: "spam" },
  });
  assert.equal(lock.data.user.isLocked, true);
  assert.equal((await call("/api/auth/me", { token: tokens.bob })).status, 401);
  const login = await call("/api/auth/login", { method: "POST", body: { login: "bob", password: "password-1" } });
  assert.equal(login.data.code, "locked");
  assert.equal(login.data.error, "Tài khoản đã bị khóa: spam");

  const demote = await call("/api/admin/users", { method: "POST", token: tokens.alice, body: { id: alice.id, role: "user" } });
  assert.equal(demote.data.code, "self_demote");
  const selfLock = await call("/api/admin/users", { method: "POST", token: tokens.alice, body: { id: alice.id, isLocked: true } });
  assert.equal(selfLock.data.code, "self_lock");
});

test("logout ends the session", async () => {
  const r = await call("/api/auth/login", { method: "POST", body: { login: "dev", password: "password-1" } });
  await call("/api/auth/logout", { method: "POST", token: r.data.token });
  assert.equal((await call("/api/auth/me", { token: r.data.token })).status, 401);
});

test("CORS for the app webview only", async () => {
  const pre = await call("/api/auth/login", { method: "OPTIONS", headers: { Origin: "tauri://localhost" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.match(pre.headers.get("access-control-allow-methods"), /\bPUT\b/);
  const win = await call("/api/status", { headers: { Origin: "http://tauri.localhost" } });
  assert.equal(win.headers.get("access-control-allow-origin"), "http://tauri.localhost");
  const evil = await call("/api/status", { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await call("/admin/")).status, 404);
});

const hw = (n) => n.toString(16).padStart(64, "a");
const redeem = (who, code, hwidHash) => call("/api/redeem", { method: "POST", token: tokens[who], body: { code, hwidHash } });
const createCode = (body) => call("/api/admin/redeems", { method: "POST", token: tokens.alice, body });
const codeRow = async (code) => (await sql("SELECT * FROM gsb_redeem_codes WHERE code = ?", [code]))[0][0];

test("admin creates redeem codes with validation", async () => {
  assert.equal((await createCode({ code: "GIFT7", rewardValue: 7, maxUses: 2 })).status, 201);
  assert.equal((await createCode({ code: "gift3", rewardValue: 3, expiresAt: "2099-12-31" })).status, 201);
  assert.equal((await createCode({ code: "a!" })).data.code, "invalid_code");
  assert.equal((await createCode({ code: "PAST", expiresAt: "2001-01-01" })).data.code, "past_expires_at");
  assert.equal((await createCode({ code: "BADDAY", expiresAt: "2099-02-30" })).data.code, "invalid_expires_at");
  assert.equal((await createCode({ code: "GIFT7" })).status, 409);
  assert.equal((await call("/api/admin/redeems", { token: tokens.dev })).status, 403);

  const list = await call("/api/admin/redeems", { token: tokens.alice });
  const gift3 = list.data.codes.find((c) => c.code === "GIFT3");
  assert.equal(gift3.expiresAt, "2099-12-31 23:59:59");
  assert.equal(gift3.rewardValue, 3);
  assert.equal(gift3.isActive, true);
  assert.equal(gift3.expired, false);
});

test("redeem pays once per account and once per machine, and extends VIP", async () => {
  for (const name of ["dave", "erin", "fay"]) {
    const r = await call("/api/auth/register", {
      method: "POST",
      body: { username: name, email: `${name}@example.com`, password: "password-1" },
    });
    tokens[name] = r.data.token;
  }
  assert.equal((await redeem("dave", "GIFT7", "DUMMY_LOCAL_HWID")).data.code, "invalid_hwid");
  assert.equal((await call("/api/redeem", { method: "POST", body: { code: "GIFT7", hwidHash: hw(1) } })).status, 401);

  const ok = await redeem("dave", "gift7", hw(1));
  assert.equal(ok.status, 200);
  const me = await call("/api/auth/me", { token: tokens.dave });
  assert.equal(me.data.user.role, "vip");
  assert.equal(me.data.user.vipUntil, ok.data.vipUntil);

  const again = await redeem("dave", "GIFT7", hw(2));
  assert.equal(again.status, 409);
  assert.match(again.data.error, /Tài khoản/);
  const sameMachine = await redeem("erin", "GIFT7", hw(1));
  assert.equal(sameMachine.status, 409);
  assert.match(sameMachine.data.error, /Máy này/);

  assert.equal((await redeem("erin", "GIFT7", hw(2))).status, 200);
  assert.equal((await redeem("fay", "GIFT7", hw(3))).data.code, "code_limit_reached");
  assert.equal((await codeRow("GIFT7")).used_count, 2);

  assert.equal((await redeem("dave", "GIFT3", hw(1))).status, 200);
  const [[d]] = await sql("SELECT TIMESTAMPDIFF(MINUTE, NOW(), vip_until) AS m FROM gsb_users WHERE username = 'dave'");
  assert.ok(Math.abs(d.m - 10 * 24 * 60) <= 2, `7 + 3 days stacked, got ${d.m} minutes`);

  // The admin panel edits the stored role, not the VIP it reports to the app.
  const users = await call("/api/admin/users?q=dave&role=", { token: tokens.alice });
  assert.equal(users.data.users[0].role, "user");
  assert.ok(users.data.users[0].vipUntil);

  await sql("UPDATE gsb_users SET vip_until = NOW() - INTERVAL 1 MINUTE WHERE username = 'dave'");
  const lapsed = await call("/api/auth/me", { token: tokens.dave });
  assert.equal(lapsed.data.user.role, "user");
  assert.equal(lapsed.data.user.vipUntil, null);
});

test("disabled and expired codes; PUT keeps what it is not given", async () => {
  const gift3 = await codeRow("GIFT3");
  const put = (body) => call(`/api/admin/redeems/${gift3.id}`, { method: "PUT", token: tokens.alice, body });

  assert.equal((await put({ isActive: false, maxUses: "abc" })).status, 200);
  let row = await codeRow("GIFT3");
  assert.equal(row.is_active, 0);
  assert.equal(row.reward_value, 3);
  assert.equal(row.max_uses, 0);
  assert.equal(row.expires_at, "2099-12-31 23:59:59");
  assert.equal((await redeem("erin", "GIFT3", hw(2))).data.code, "code_disabled");

  assert.equal((await put({ expiresAt: "not-a-date" })).data.code, "invalid_expires_at");
  await put({ isActive: true, expiresAt: null });
  assert.equal((await codeRow("GIFT3")).expires_at, null);

  await sql("UPDATE gsb_redeem_codes SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?", [gift3.id]);
  assert.equal((await redeem("erin", "GIFT3", hw(2))).data.code, "code_expired");

  const toggle = await call(`/api/admin/redeems/${gift3.id}`, { method: "DELETE", token: tokens.alice });
  assert.equal(toggle.status, 200);
  assert.equal((await codeRow("GIFT3")).is_active, 0);
  assert.equal((await call("/api/admin/redeems/999999", { method: "PUT", token: tokens.alice, body: {} })).status, 404);
});

test("concurrent redeems cannot go past max_uses", async () => {
  await createCode({ code: "RACE", rewardValue: 1, maxUses: 1 });
  const names = [1, 2, 3, 4, 5, 6].map((i) => `racer${i}`);
  for (const name of names) {
    const r = await call("/api/auth/register", {
      method: "POST",
      body: { username: name, email: `${name}@example.com`, password: "password-1" },
    });
    assert.equal(r.status, 201);
    tokens[name] = r.data.token;
  }
  const results = await Promise.all(names.map((n, i) => redeem(n, "RACE", hw(100 + i))));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await codeRow("RACE")).used_count, 1);
  const [[n]] = await sql("SELECT COUNT(*) AS n FROM gsb_hwid_redeems r JOIN gsb_redeem_codes c ON c.id = r.code_id WHERE c.code = 'RACE'");
  assert.equal(n.n, 1);
});

test("guessing redeem codes is rate limited", async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await redeem("fay", `NOPE${i}`, hw(3))).status, 404);
  }
  assert.equal((await redeem("fay", "NOPE10", hw(3))).status, 429);
});

test("repeated failures are rate limited", async () => {
  let last;
  for (let i = 0; i < 4; i++) {
    last = await call("/api/auth/login", { method: "POST", body: { login: "ghost", password: "wrong-pass" } });
  }
  assert.equal(last.status, 429);
  assert.equal(last.data.code, "rate_limited");
});
