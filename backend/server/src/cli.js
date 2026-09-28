// Server-side maintenance, run on the VPS:
//   node --env-file=/etc/goslynk-api/env src/cli.js migrate
//   node --env-file=/etc/goslynk-api/env src/cli.js set-role <username> <user|vip|developer|admin>
//   node --env-file=/etc/goslynk-api/env src/cli.js set-setting <key> <value>
//   node --env-file=/etc/goslynk-api/env src/cli.js set-setting relay_psk --from-file /etc/gpb/psk
import fs from "node:fs";
import { ROLES, setSetting } from "./lib.js";
import { one, run, pool, migrate as migrateSchema } from "./db.js";

const SETTINGS = ["developer_mode", "developer_message", "registration_open", "relay_endpoint", "relay_psk"];

async function migrate() {
  console.log("gsb tables:", (await migrateSchema()).join(", "));
}

async function setRole(username, role) {
  if (!username || !ROLES.includes(role)) throw new Error(`usage: set-role <username> <${ROLES.join("|")}>`);
  const u = await one("SELECT id, role FROM gsb_users WHERE username = ?", [username]);
  if (!u) throw new Error(`no account named ${username}`);
  await run("UPDATE gsb_users SET role = ?, is_locked = 0, lock_reason = '' WHERE id = ?", [role, u.id]);
  await run("INSERT INTO gsb_audit_log (actor_id, action, target, detail, ip) VALUES (NULL, 'role', ?, ?, 'cli')", [
    username,
    `${u.role} -> ${role}`,
  ]);
  console.log(`${username}: ${u.role} -> ${role}`);
}

async function setSettingCmd(key, value, file) {
  if (!SETTINGS.includes(key)) throw new Error(`key must be one of: ${SETTINGS.join(", ")}`);
  if (value === "--from-file") value = fs.readFileSync(file, "utf8").trim();
  if (value === undefined) throw new Error("usage: set-setting <key> <value> | set-setting <key> --from-file <path>");
  await setSetting(key, value);
  console.log(`${key} updated`);
}

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  migrate: () => migrate(),
  "set-role": () => setRole(args[0], args[1]),
  "set-setting": () => setSettingCmd(args[0], args[1], args[2]),
};

try {
  if (!commands[cmd]) throw new Error(`commands: ${Object.keys(commands).join(", ")}`);
  await commands[cmd]();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
