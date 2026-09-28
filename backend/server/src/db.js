import fs from "node:fs";
import mysql from "mysql2/promise";
import { config } from "./config.js";

export const pool = mysql.createPool({
  ...config.db,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 8,
  connectTimeout: 10_000,
  // DATETIME/TIMESTAMP come back as the database's own text, which is what the admin panel shows.
  dateStrings: true,
  enableKeepAlive: true,
});

export async function one(sql, args = []) {
  const [rows] = await pool.execute(sql, args);
  return rows[0] ?? null;
}

export async function all(sql, args = []) {
  const [rows] = await pool.execute(sql, args);
  return rows;
}

export async function run(sql, args = []) {
  const [res] = await pool.execute(sql, args);
  return res;
}

/** Runs `fn(conn)` in a transaction; any throw rolls it back. */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

const SCHEMA = new URL("../../database.sql", import.meta.url);

// Columns added after their table first shipped: CREATE TABLE IF NOT EXISTS leaves an older table
// without them, so migrate adds each one that is missing.
const ADDED_COLUMNS = [
  ["gsb_users", "vip_until", "DATETIME NULL DEFAULT NULL AFTER `role`"],
  ["gsb_users", "vip_plus_until", "DATETIME NULL DEFAULT NULL AFTER `vip_until`"],
  ["gsb_sessions", "ended_reason", "VARCHAR(16) NOT NULL DEFAULT '' AFTER `expires_at`"],
];

// ENUM columns that gained a value: [table, column, value that must exist, full new definition].
const WIDENED_ENUMS = [
  ["gsb_users", "role", "vip_plus", "ENUM('user', 'vip', 'vip_plus', 'developer', 'admin') NOT NULL DEFAULT 'user'"],
  [
    "gsb_redeem_codes",
    "reward_type",
    "vip_plus_days",
    "ENUM('vip_days', 'vip_plus_days', 'role') NOT NULL DEFAULT 'vip_days'",
  ],
];

/** Brings the schema up to date. Safe to run repeatedly: every step checks before it changes. */
export async function migrate() {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true, charset: "utf8mb4" });
  try {
    await conn.query(fs.readFileSync(SCHEMA, "utf8"));
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const [cols] = await conn.query(
        "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        [table, column],
      );
      if (!cols.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    }
    for (const [table, column, value, definition] of WIDENED_ENUMS) {
      const [[col]] = await conn.query(
        "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        [table, column],
      );
      if (col && !col.t.includes(`'${value}'`)) {
        await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
      }
    }
    const [rows] = await conn.query("SHOW TABLES LIKE 'gsb\\_%'");
    return rows.map((r) => Object.values(r)[0]);
  } finally {
    await conn.end();
  }
}
