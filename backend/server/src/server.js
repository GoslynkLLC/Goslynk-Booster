import { config } from "./config.js";
import { createApp, cleanupExpired, ensureMigrations, pool } from "./app.js";

ensureMigrations().catch((e) => console.error("migration:", e.message));

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`goslynk-api listening on http://${config.host}:${config.port}`);
});

const sweep = () => cleanupExpired().catch((e) => console.error("cleanup:", e.message));
sweep();
const timer = setInterval(sweep, 60 * 60 * 1000);

function shutdown() {
  clearInterval(timer);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
