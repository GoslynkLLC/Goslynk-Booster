import { useCallback, useEffect, useState } from "react";
import { adminRedeemApi } from "../api.js";
import { REWARD_LABEL, shortDate } from "../format.js";

export default function RedeemCodesTab({ guard }) {
  const [codes, setCodes] = useState(null);
  const [error, setError] = useState("");
  // null: no dialog, {}: create, a code: edit it.
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    adminRedeemApi
      .list()
      .then((r) => {
        setCodes(r.codes);
        setError("");
      })
      .catch((e) => guard(e, setError));
  }, [guard]);

  useEffect(load, [load]);

  async function toggle(c) {
    try {
      await adminRedeemApi.toggle(c.id);
      load();
    } catch (e) {
      guard(e, setError);
    }
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="panel-title">Mã quà tặng</p>
            <p className="hint">Mỗi mã cộng ngày VIP hoặc VIP+, nhận được một lần trên mỗi tài khoản và mỗi máy.</p>
          </div>
          <button type="button" className="btn primary sm" onClick={() => setEditing({})}>
            Tạo mã
          </button>
        </div>

        {codes === null ? (
          <p className="hint">Đang tải…</p>
        ) : codes.length === 0 ? (
          <p className="hint">Chưa có mã nào.</p>
        ) : (
          <table className="redeem-table">
            <thead>
              <tr>
                <th>Mã</th>
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
                    <span className="code-reward">
                      +{c.rewardValue} ngày {REWARD_LABEL[c.rewardType] || c.rewardType}
                    </span>
                  </td>
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
      </section>

      {error ? <p className="error">{error}</p> : null}

      {editing ? (
        <CodeDialog
          code={editing.id ? editing : null}
          guard={guard}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </>
  );
}

function CodeDialog({ code, guard, onClose, onSaved }) {
  const [name, setName] = useState(code?.code ?? "");
  const [rewardType, setRewardType] = useState(code?.rewardType ?? "vip_days");
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
      else await adminRedeemApi.create({ ...body, rewardType, code: name.trim().toUpperCase() });
      onSaved();
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
              Loại quà
              <select value={rewardType} onChange={(e) => setRewardType(e.target.value)} disabled={!!code}>
                <option value="vip_days">Ngày VIP (1 thiết bị)</option>
                <option value="vip_plus_days">Ngày VIP+ (2 thiết bị)</option>
              </select>
            </label>
            <label>
              Số ngày {REWARD_LABEL[rewardType] || ""}
              <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
          </div>
          <div className="field-row">
            <label>
              Lượt dùng (0 = không giới hạn)
              <input type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </label>
            <label>
              Hết hạn cuối ngày (trống = không)
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </label>
          </div>
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
