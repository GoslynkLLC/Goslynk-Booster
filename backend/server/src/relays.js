// Relay list: exits (relayd, NAT next to the game servers) and entries (plain UDP forwarders in front
// of one exit). The app handshakes with each exit meant for the game, keeps the fastest, and uses an
// entry as a second road for multipath. Endpoints are public; the PSK stays a single setting.
import { all, one, run } from "./db.js";
import { fail, str, audit } from "./lib.js";

export const ENDPOINT_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const ID_RE = /^[a-z0-9-]{2,32}$/;
const GAME_RE = /^[a-z0-9_-]{2,32}$/;
const ROLES = ["exit", "entry"];
const MAX_RELAYS = 16;
const MAX_GAMES = 20;

function view(r) {
  return {
    id: r.id,
    name: r.name,
    location: r.location,
    endpoint: r.endpoint,
    role: r.role,
    exitId: r.exit_id ?? null,
    games: r.games ? r.games.split(",") : [],
    enabled: Number(r.enabled) === 1,
    sort: Number(r.sort),
  };
}

export async function listRelays() {
  const rows = await all("SELECT * FROM gsb_relays ORDER BY sort, id");
  return rows.map(view);
}

/**
 * What a client that may boost is told: enabled exits, each with the endpoints of its enabled
 * entries. `games` empty means the exit serves every game.
 */
export async function clientRelays() {
  const relays = (await listRelays()).filter((r) => r.enabled);
  return relays
    .filter((r) => r.role === "exit")
    .map((x) => ({
      id: x.id,
      name: x.name,
      location: x.location,
      endpoint: x.endpoint,
      games: x.games,
      entries: relays.filter((e) => e.role === "entry" && e.exitId === x.id).map((e) => e.endpoint),
    }));
}

function parseGames(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const games = [...new Set(list.map((g) => String(g).trim().toLowerCase()).filter(Boolean))];
  if (games.length > MAX_GAMES || games.some((g) => !GAME_RE.test(g))) {
    fail("Danh sách game không hợp lệ (id game cách nhau bằng dấu phẩy, ví dụ lol,tft).", 422, "invalid_games");
  }
  return games.join(",");
}

/** The fields of a relay from an admin request, validated. `current` is the row being edited. */
async function parseRelay(body, current = null) {
  const pick = (key, fallback) => (Object.hasOwn(body, key) ? body[key] : fallback);
  const name = typeof body.name === "string" ? str(body, "name", 64) : current?.name ?? "";
  const location = typeof body.location === "string" ? str(body, "location", 64) : current?.location ?? "";
  const endpoint = typeof body.endpoint === "string" ? str(body, "endpoint", 100) : current?.endpoint ?? "";
  const role = String(pick("role", current?.role ?? "exit"));
  const games = parseGames(pick("games", current?.games ?? []));
  const enabled = Boolean(pick("enabled", current?.enabled ?? true));
  const sort = Number.parseInt(pick("sort", current?.sort ?? 0), 10) || 0;
  let exitId = pick("exitId", current?.exitId ?? null);

  if (!name) fail("Tên relay không được để trống.", 422, "invalid_name");
  if (!ENDPOINT_RE.test(endpoint)) {
    fail("Endpoint phải có dạng host:port, ví dụ 203.0.113.10:51820.", 422, "invalid_endpoint");
  }
  if (!ROLES.includes(role)) fail("Vai trò phải là exit hoặc entry.", 422, "invalid_role");
  if (role === "entry") {
    exitId = String(exitId ?? "");
    const exit = await one("SELECT role FROM gsb_relays WHERE id = ?", [exitId]);
    if (!exit || exit.role !== "exit") fail("Entry phải thuộc một relay exit có sẵn.", 422, "invalid_exit");
  } else {
    exitId = null;
  }
  return { name, location, endpoint, role, exitId, games: role === "exit" ? games : "", enabled, sort };
}

async function findRelay(id) {
  const row = await one("SELECT * FROM gsb_relays WHERE id = ?", [id]);
  if (!row) fail("Không tìm thấy relay.", 404, "not_found");
  return view(row);
}

const summary = (r) => `${r.role} ${r.endpoint}${r.games ? ` games=${r.games}` : ""}${r.enabled ? "" : " (tắt)"}`;

/** Validates and stores a new relay; used by the admin panel and the CLI. */
export async function addRelay(body, actorId = null, ip = "cli") {
  const id = str(body, "id", 32).toLowerCase();
  if (!ID_RE.test(id)) fail("Mã relay chỉ gồm a-z, 0-9 và dấu -, dài 2-32 ký tự.", 422, "invalid_id");
  if (await one("SELECT 1 AS x FROM gsb_relays WHERE id = ?", [id])) {
    fail("Mã relay đã tồn tại.", 409, "duplicate_id");
  }
  const { n } = await one("SELECT COUNT(*) AS n FROM gsb_relays");
  if (Number(n) >= MAX_RELAYS) fail(`Tối đa ${MAX_RELAYS} relay.`, 422, "too_many");
  const r = await parseRelay(body);
  await run(
    `INSERT INTO gsb_relays (id, name, location, endpoint, role, exit_id, games, enabled, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, r.name, r.location, r.endpoint, r.role, r.exitId, r.games, r.enabled ? 1 : 0, r.sort],
  );
  await audit(actorId, "relay_add", id, summary(r), ip);
  return id;
}

export function relayRoutes(admin) {
  admin.get("/relays", async (req, res) => {
    res.json({ ok: true, relays: await listRelays() });
  });

  admin.post("/relays", async (req, res) => {
    await addRelay(req.body ?? {}, req.admin.id, req.ip);
    res.status(201).json({ ok: true, relays: await listRelays() });
  });

  admin.put("/relays/:id", async (req, res) => {
    const current = await findRelay(String(req.params.id));
    const r = await parseRelay(req.body ?? {}, current);
    if (current.role === "exit" && r.role !== "exit") {
      const { n } = await one("SELECT COUNT(*) AS n FROM gsb_relays WHERE exit_id = ?", [current.id]);
      if (Number(n) > 0) fail("Relay exit này còn entry trỏ tới, hãy chuyển các entry đó trước.", 422, "has_entries");
    }
    await run(
      `UPDATE gsb_relays SET name = ?, location = ?, endpoint = ?, role = ?, exit_id = ?, games = ?, enabled = ?, sort = ?
       WHERE id = ?`,
      [r.name, r.location, r.endpoint, r.role, r.exitId, r.games, r.enabled ? 1 : 0, r.sort, current.id],
    );
    await audit(req.admin.id, "relay_edit", current.id, summary(r), req.ip);
    res.json({ ok: true, relays: await listRelays() });
  });

  admin.delete("/relays/:id", async (req, res) => {
    const current = await findRelay(String(req.params.id));
    const { n } = await one("SELECT COUNT(*) AS n FROM gsb_relays WHERE exit_id = ?", [current.id]);
    if (Number(n) > 0) fail("Relay exit này còn entry trỏ tới, hãy xoá các entry đó trước.", 422, "has_entries");
    await run("DELETE FROM gsb_relays WHERE id = ?", [current.id]);
    await audit(req.admin.id, "relay_delete", current.id, summary(current), req.ip);
    res.json({ ok: true, relays: await listRelays() });
  });
}
