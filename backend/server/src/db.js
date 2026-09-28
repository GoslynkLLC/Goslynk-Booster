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

/** Brings the schema up to date. Safe to run repeatedly: every step checks before it changes. */
export async function migrate() {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true, charset: "utf8mb4" });
  try {
    await conn.query(fs.readFileSync(SCHEMA, "utf8"));
    // CREATE TABLE IF NOT EXISTS leaves a gsb_users made by an older schema without the column.
    const [cols] = await conn.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gsb_users' AND COLUMN_NAME = 'vip_until'`,
    );
    if (!cols.length) {
      await conn.query("ALTER TABLE `gsb_users` ADD COLUMN `vip_until` DATETIME NULL DEFAULT NULL AFTER `role`");
    }
    const [rows] = await conn.query("SHOW TABLES LIKE 'gsb\\_%'");
    return rows.map((r) => Object.values(r)[0]);
  } finally {
    await conn.end();
  }
}
