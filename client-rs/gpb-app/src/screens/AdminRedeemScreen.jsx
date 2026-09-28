import { useCallback, useEffect, useState } from "react";
import { adminRedeemApi, errMsg, isSessionRejected } from "../api.js";

/** "2026-10-05 23:59:59" (server time) as "05/10/2026". */
const shortDate = (s) => s.slice(0, 10).split("-").reverse().join("/");

export default function AdminRedeemScreen({ onSessionRejected, onBack }) {
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState("");
  // null: no dialog, {}: create, a code: edit it.
  const [editing, setEditing] = useState(null);

  const guard = useCallback(
    (e) => {
      if (isSessionRejected(e) || e?.code === "forbidden") onSessionRejected(e.message);
      else setError(errMsg(e));
    },
    [onSessionRejected],
  );

  const load = useCallback(() => {
    adminRedeemApi
      .list()
      .then((r) => {
        setCodes(r.codes);
        setError("");
      })
      .catch(guard);
  }, [guard]);

  useEffect(load, [load]);

  async function toggle(c) {
    try {
      await adminRedeemApi.toggle(c.id);
      load();
    } catch (e) {
      guard(e);
    }
  }

  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>Mã quà tặng</h1>
          <p className="tag">Mỗi mã cộng ngày VIP, nhận được một lần trên mỗi tài khoản và mỗi máy</p>
        </div>
        <div className="row-actions">
          <button type="button" className="btn primary sm" onClick={() => setEditing({})}>
            Tạo mã
          </button>
          <button type="button" className="btn ghost sm" onClick={onBack}>
            Menu
          </button>
        </div>
      </header>

      {error ? <p className="modal-message error">{error}</p> : null}

      <div className="stats">
        {codes === null ? (
          <p className="muted">Đang tải…</p>
        ) : codes.length === 0 ? (
          <p className="muted">Chưa có mã nào. Bấm "Tạo mã" để tạo.</p>
        ) : (
          <table className="redeem-table">
            <thead>
              <tr>
                <th>Mã</th>
                <th>Quà</th>
                <th>Đã dùng</th>
                <th>Hết hạn</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className={c.isActive && !c.expired ? "" : "off"}>
                  <td>
                    <button type="button" className="code-link" onClick={() => setEditing(c)} title="Sửa mã">
                      {c.code}
                    </button>
                  </td>
                  <td>+{c.rewardValue} ngày VIP</td>
                  <td>
                    {c.usedCount} / {c.maxUses === 0 ? "∞" : c.maxUses}
                  </td>
                  <td className="muted">{c.expiresAt ? shortDate(c.expiresAt) : "Không"}</td>
                  <td>
                    {c.expired ? (
                      <span className="pill expired">Hết hạn</span>
                    ) : c.isActive ? (
                      <span className="pill on">Đang mở</span>
                    ) : (
                      <span className="pill off">Đã khóa</span>
                    )}
                  </td>
                  <td>
                    <div className="actions">
                      <button type="button" className="btn ghost sm" onClick={() => setEditing(c)}>
                        Sửa
                      </button>
                      <button
                        type="button"
                        className={`btn ghost sm${c.isActive ? " danger-text" : ""}`}
                        onClick={() => toggle(c)}
                      >
                        {c.isActive ? "Khóa" : "Mở"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing ? (
        <CodeDialog
          code={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onSessionRejected={onSessionRejected}
        />
      ) : null}
    </section>
  );
}

function CodeDialog({ code, onClose, onSaved, onSessionRejected }) {
  const [name, setName] = useState(code?.code ?? "");
  const [days, setDays] = useState(String(code?.rewardValue ?? 7));
  const [maxUses, setMaxUses] = useState(String(code?.maxUses ?? 0));
  const [expiresAt, setExpiresAt] = useState(code?.expiresAt ? code.expiresAt.slice(0, 10) : "");
  const [active, setActive] = useState(code?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = { rewardValue: Number(days), maxUses: Number(maxUses), expiresAt: expiresAt || null };
    try {
      if (code) await adminRedeemApi.update(code.id, { ...body, isActive: active });
      else await adminRedeemApi.create({ ...body, code: name.trim().toUpperCase() });
      onSaved();
    } catch (err) {
      if (isSessionRejected(err) || err?.code === "forbidden") onSessionRejected(err.message);
      else setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-dialog form" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{code ? `Sửa mã ${code.code}` : "Tạo mã quà tặng"}</h3>
          <button type="button" className="modal-close" aria-label="Đóng" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          {code ? null : (
            <label>
              Mã code (chữ in hoa, số, dấu chấm, gạch dưới)
              <input
                className="code-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="VD: GOSLYNK2026"
                maxLength={64}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <div className="field-row">
            <label>
              Số ngày VIP
              <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <label>
              Lượt dùng (0 = không giới hạn)
              <input type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </label>
          </div>
          <label>
            Hết hạn cuối ngày (để trống = không hết hạn)
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
          {code ? (
            <label>
              Trạng thái
              <select value={active ? "1" : "0"} onChange={(e) => setActive(e.target.value === "1")}>
                <option value="1">Đang mở</option>
                <option value="0">Đã khóa</option>
              </select>
            </label>
          ) : null}

          {error ? <p className="modal-message error">{error}</p> : null}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Hủy
            </button>
            <button type="submit" className="btn primary" disabled={busy || (!code && !name.trim())}>
              {busy ? "Đang lưu…" : code ? "Lưu" : "Tạo mã"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
