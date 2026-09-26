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
const fs = await import("node:fs");
const mysql = (await import("mysql2/promise")).default;

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
  await conn.query(
    "DROP TABLE IF EXISTS gsb_sessions, gsb_login_attempts, gsb_audit_log, gsb_settings, gsb_users",
  );
  await conn.query(fs.readFileSync(new URL("../../database.sql", import.meta.url), "utf8"));
  await conn.end();

  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
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
  const win = await call("/api/status", { headers: { Origin: "http://tauri.localhost" } });
  assert.equal(win.headers.get("access-control-allow-origin"), "http://tauri.localhost");
  const evil = await call("/api/status", { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  assert.equal((await call("/admin/")).status, 404);
});

test("repeated failures are rate limited", async () => {
  let last;
  for (let i = 0; i < 4; i++) {
    last = await call("/api/auth/login", { method: "POST", body: { login: "ghost", password: "wrong-pass" } });
  }
  assert.equal(last.status, 429);
  assert.equal(last.data.code, "rate_limited");
});
