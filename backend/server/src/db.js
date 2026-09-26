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
