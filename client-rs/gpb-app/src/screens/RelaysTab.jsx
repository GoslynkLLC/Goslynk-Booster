import { useCallback, useEffect, useState } from "react";
import { adminRelayApi } from "../api.js";

const ROLE_LABEL = { exit: "Exit", entry: "Entry" };

export default function RelaysTab({ guard }) {
  const [relays, setRelays] = useState(null);
  const [error, setError] = useState("");
  // null: no dialog, {}: create, a relay: edit it.
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(() => {
    adminRelayApi
      .list()
      .then((r) => {
        setRelays(r.relays);
        setError("");
      })
      .catch((e) => guard(e, setError));
  }, [guard]);

  useEffect(load, [load]);

  async function run(action) {
    setError("");
    try {
      const r = await action();
      setRelays(r.relays);
    } catch (e) {
      guard(e, setError);
    }
  }

  const exits = relays?.filter((r) => r.role === "exit") ?? [];
  const nameOf = (id) => relays?.find((r) => r.id === id)?.name || id;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-title">Relay</p>
            <p className="hint">
              App đo mọi exit dành cho game rồi chọn exit nhanh nhất. Exit không ghi game nào thì dùng cho mọi game.
              Entry là đường thứ hai tới một exit, dùng để gửi song song (multipath).
            </p>
          </div>
          <button type="button" className="btn primary sm" onClick={() => setEditing({})}>
            Thêm relay
          </button>
        </div>

        {relays === null ? (
          <p className="hint">Đang tải…</p>
        ) : relays.length === 0 ? (
          <p className="hint">Chưa có relay nào.</p>
        ) : (
          <table className="redeem-table">
            <thead>
              <tr>
                <th>Relay</th>
                <th>Vai trò</th>
                <th>Game</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {relays.map((r) => (
                <tr key={r.id} className={r.enabled ? "" : "off"}>
                  <td>
                    <button type="button" className="code-link" onClick={() => setEditing(r)} title="Sửa relay">
                      {r.name}
                    </button>
                    <span className="code-reward">
                      {r.id} · {r.endpoint}
                      {r.location ? ` · ${r.location}` : ""}
                    </span>
                  </td>
                  <td>
                    {ROLE_LABEL[r.role] || r.role}
                    {r.role === "entry" ? <span className="code-reward">→ {nameOf(r.exitId)}</span> : null}
                  </td>
                  <td className="muted">{r.role === "exit" ? (r.games.length ? r.games.join(", ") : "Mọi game") : "—"}</td>
                  <td>
                    {r.enabled ? <span className="pill on">Bật</span> : <span className="pill off">Tắt</span>}
                  </td>
                  <td>
                    {confirmDelete === r.id ? (
                      <div className="actions">
                        <button type="button" className="btn ghost sm" onClick={() => setConfirmDelete(null)}>
                          Hủy
                        </button>
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={() => {
                            setConfirmDelete(null);
                            run(() => adminRelayApi.remove(r.id));
                          }}
                        >
                          Xoá
                        </button>
                      </div>
                    ) : (
                      <div className="actions">
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => run(() => adminRelayApi.update(r.id, { enabled: !r.enabled }))}
                        >
                          {r.enabled ? "Tắt" : "Bật"}
                        </button>
                        <button type="button" className="btn ghost sm danger-text" onClick={() => setConfirmDelete(r.id)}>
                          Xoá
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {error ? <p className="error">{error}</p> : null}

      {editing ? (
        <RelayDialog
          relay={editing.id ? editing : null}
          exits={exits}
          guard={guard}
          onClose={() => setEditing(null)}
          onSaved={(list) => {
            setEditing(null);
            setRelays(list);
          }}
        />
      ) : null}
    </>
  );
}

function RelayDialog({ relay, exits, guard, onClose, onSaved }) {
  const [id, setId] = useState(relay?.id ?? "");
  const [name, setName] = useState(relay?.name ?? "");
  const [location, setLocation] = useState(relay?.location ?? "");
  const [endpoint, setEndpoint] = useState(relay?.endpoint ?? "");
  const [role, setRole] = useState(relay?.role ?? "exit");
  const [exitId, setExitId] = useState(relay?.exitId ?? exits[0]?.id ?? "");
  const [games, setGames] = useState(relay?.games?.join(",") ?? "");
  const [sort, setSort] = useState(String(relay?.sort ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const exitChoices = exits.filter((x) => x.id !== relay?.id);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = {
      name: name.trim(),
      location: location.trim(),
      endpoint: endpoint.trim(),
      role,
      exitId: role === "entry" ? exitId : null,
      games: role === "exit" ? games : "",
      sort: Number(sort) || 0,
    };
    try {
      const r = relay
        ? await adminRelayApi.update(relay.id, body)
        : await adminRelayApi.create({ ...body, id: id.trim().toLowerCase() });
      onSaved(r.relays);
    } catch (err) {
      guard(err, setError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-dialog form" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{relay ? `Sửa relay ${relay.id}` : "Thêm relay"}</h3>
          <button type="button" className="modal-close" aria-label="Đóng" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field-row">
            <label>
              Mã (a-z, 0-9, -)
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="vn-1"
                maxLength={32}
                disabled={!!relay}
                autoFocus={!relay}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Vai trò
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="exit">Exit (chạy relayd)</option>
                <option value="entry" disabled={exitChoices.length === 0}>
                  Entry (chuyển tiếp tới exit)
                </option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label>
              Tên hiển thị
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Goslynk VN-1" maxLength={64} />
            </label>
            <label>
              Vị trí
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Việt Nam" maxLength={64} />
            </label>
          </div>
          <label>
            Endpoint
            <input
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="203.0.113.10:51820"
              maxLength={100}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {role === "exit" ? (
            <label>
              Chỉ dùng cho game (id cách nhau bằng dấu phẩy, trống = mọi game)
              <input
                value={games}
                onChange={(e) => setGames(e.target.value)}
                placeholder="lol,tft"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <label>
              Chuyển tiếp tới exit
              <select value={exitId} onChange={(e) => setExitId(e.target.value)}>
                {exitChoices.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.id})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Thứ tự hiển thị
            <input type="number" value={sort} onChange={(e) => setSort(e.target.value)} />
          </label>

          {error ? <p className="modal-message error">{error}</p> : null}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Hủy
            </button>
            <button type="submit" className="btn primary" disabled={busy || (!relay && !id.trim())}>
              {busy ? "Đang lưu…" : relay ? "Lưu" : "Thêm relay"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
