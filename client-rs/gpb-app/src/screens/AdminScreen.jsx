import { useCallback, useEffect, useRef, useState } from "react";
import { adminApi, errMsg, isSessionRejected } from "../api.js";
import RedeemCodesTab from "./RedeemCodesTab.jsx";

const ROLES = ["user", "vip", "vip_plus", "developer", "admin"];
const TABS = [
  ["general", "Chung"],
  ["users", "Tài khoản"],
  ["redeem", "Mã quà"],
  ["audit", "Lịch sử"],
];
const ACTION_LABEL = {
  register: "Đăng ký",
  role: "Đổi role",
  lock: "Khóa",
  unlock: "Mở khóa",
  revoke_sessions: "Đăng xuất thiết bị",
  setting: "Cài đặt",
  profile: "Sửa hồ sơ",
  password: "Đổi mật khẩu",
  signed_out_elsewhere: "Đăng nhập máy khác",
  redeem_code: "Nhận mã quà",
  redeem_invalid: "Nhập sai mã",
  create_redeem_code: "Tạo mã quà",
  update_redeem_code: "Sửa mã quà",
  enable_redeem_code: "Mở mã quà",
  disable_redeem_code: "Khóa mã quà",
};

export default function AdminScreen({ me, onChanged, onSessionRejected, onBack }) {
  const [tab, setTab] = useState("general");

  // Losing admin rights or the session mid-way ends the session like any other refusal.
  const guard = useCallback(
    (e, setError) => {
      if (isSessionRejected(e) || e?.code === "forbidden") onSessionRejected(e.message);
      else setError(errMsg(e));
    },
    [onSessionRejected],
  );

  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>Quản trị</h1>
          <p className="tag">Goslynk Booster · {me.displayName || me.username}</p>
        </div>
        <button type="button" className="btn ghost sm" onClick={onBack}>
          Menu
        </button>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "general" && <GeneralTab guard={guard} onChanged={onChanged} />}
      {tab === "users" && <UsersTab me={me} guard={guard} />}
      {tab === "redeem" && <RedeemCodesTab guard={guard} />}
      {tab === "audit" && <AuditTab guard={guard} />}
    </section>
  );
}

function GeneralTab({ guard, onChanged }) {
  const [s, setS] = useState(null);
  const [message, setMessage] = useState("");
  const [registrationOpen, setRegistrationOpen] = useState(true);
  const [endpoint, setEndpoint] = useState("");
  const [psk, setPsk] = useState("");
  const [showPsk, setShowPsk] = useState(false);
  const [confirmDev, setConfirmDev] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");

  const apply = (next) => {
    setS(next);
    setMessage(next.developerMessage);
    setRegistrationOpen(next.registrationOpen);
    setEndpoint(next.relayEndpoint);
    setPsk(next.relayPsk);
  };

  useEffect(() => {
    adminApi
      .settings()
      .then((d) => apply(d.settings))
      .catch((e) => guard(e, setError));
  }, [guard]);

  async function save(patch, doneText) {
    setBusy(true);
    setError("");
    setOk("");
    try {
      const d = await adminApi.saveSettings(patch);
      apply(d.settings);
      setOk(doneText);
      onChanged();
    } catch (e) {
      guard(e, setError);
    } finally {
      setBusy(false);
      setConfirmDev(false);
    }
  }

  if (!s) return error ? <p className="error">{error}</p> : <p className="hint">Đang tải…</p>;

  return (
    <>
      <section className={`panel${s.developerMode ? " danger" : ""}`}>
        <div className="panel-head">
          <div>
            <p className="panel-title">Chế độ developer</p>
            <p className="hint">
              {s.developerMode
                ? "Đang BẬT: chỉ admin và developer vào được app."
                : "Đang tắt: mọi tài khoản đều vào được app."}
            </p>
          </div>
          <button
            type="button"
            className={`switch${s.developerMode ? " on" : ""}`}
            role="switch"
            aria-label="Chế độ developer"
            aria-checked={s.developerMode}
            disabled={busy}
            onClick={() =>
              s.developerMode
                ? save({ developerMode: false }, "Đã tắt chế độ developer.")
                : setConfirmDev(true)
            }
          >
            <span />
          </button>
        </div>
        {confirmDev ? (
          <div className="confirm">
            <p>User và VIP sẽ bị chặn ngay, người đang mở app bị đăng xuất trong vòng 1 phút.</p>
            <div className="row-actions">
              <button type="button" className="btn ghost sm" onClick={() => setConfirmDev(false)}>
                Hủy
              </button>
              <button
                type="button"
                className="btn danger sm"
                disabled={busy}
                onClick={() => save({ developerMode: true, developerMessage: message }, "Đã bật chế độ developer.")}
              >
                Bật chế độ developer
              </button>
            </div>
          </div>
        ) : null}
        <label>
          Thông báo cho người bị chặn
          <textarea rows={2} maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={registrationOpen} onChange={(e) => setRegistrationOpen(e.target.checked)} />
          Cho phép đăng ký tài khoản mới
        </label>
        <button
          type="button"
          className="btn primary sm"
          disabled={busy}
          onClick={() => save({ developerMessage: message, registrationOpen }, "Đã lưu.")}
        >
          Lưu
        </button>
      </section>

      <section className="panel">
        <p className="panel-title">Relay</p>
        <p className="hint">App của mọi người nhận endpoint và PSK này sau khi đăng nhập.</p>
        <label>
          Endpoint
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="74.81.54.113:51820" autoComplete="off" />
        </label>
        <label>
          PSK
          <span className="input-row">
            <input
              type={showPsk ? "text" : "password"}
              value={psk}
              onChange={(e) => setPsk(e.target.value)}
              autoComplete="off"
            />
            <button type="button" className="btn ghost sm" onClick={() => setShowPsk((v) => !v)}>
              {showPsk ? "Ẩn" : "Hiện"}
            </button>
          </span>
        </label>
        <button
          type="button"
          className="btn primary sm"
          disabled={busy}
          onClick={() => save({ relayEndpoint: endpoint.trim(), relayPsk: psk.trim() }, "Đã lưu relay.")}
        >
          Lưu relay
        </button>
      </section>

      {ok ? <p className="ok">{ok}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}

function UsersTab({ me, guard }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(null); // { id, kind: "lock" | "revoke", reason }
  const [error, setError] = useState("");
  const reqId = useRef(0);

  const load = useCallback(() => {
    const id = ++reqId.current;
    adminApi
      .users({ q: q.trim(), role, page })
      .then((d) => {
        if (id === reqId.current) setData(d);
      })
      .catch((e) => guard(e, setError));
  }, [q, role, page, guard]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function update(id, patch) {
    setError("");
    try {
      await adminApi.updateUser(id, patch);
      setPending(null);
    } catch (e) {
      guard(e, setError);
    }
    load();
  }

  const c = data?.roleCounts;

  return (
    <>
      <div className="filters">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Tìm tên, email…"
        />
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Tất cả</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      {c ? (
        <p className="hint">
          {data.total} tài khoản · admin {c.admin} · developer {c.developer} · vip+ {c.vip_plus ?? 0} · vip {c.vip} · user {c.user}
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="user-list">
        {data?.users.map((u) => {
          const self = u.id === me.id;
          const p = pending?.id === u.id ? pending : null;
          return (
            <article key={u.id} className={`user-card${u.isLocked ? " locked" : ""}`}>
              <div className="user-head">
                <div className="user-id">
                  <strong>{u.displayName}</strong>
                  <span className="muted">
                    {u.username} · {u.email}
                  </span>
                </div>
                <select
                  value={u.role}
                  disabled={self}
                  title={self ? "Không thể tự đổi role của mình" : "Đổi role"}
                  onChange={(e) => update(u.id, { role: e.target.value })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <p className="user-meta">
                {u.isLocked ? (
                  <span className="badge locked">Đã khóa{u.lockReason ? `: ${u.lockReason}` : ""}</span>
                ) : (
                  <span className="badge active">Hoạt động</span>
                )}
                <span className="muted">
                  {u.lastLoginAt ? `Đăng nhập ${u.lastLoginAt}` : "Chưa đăng nhập"}
                  {u.lastLoginIp ? ` · ${u.lastLoginIp}` : ""}
                </span>
              </p>

              {p?.kind === "lock" ? (
                <div className="confirm">
                  <input
                    autoFocus
                    value={p.reason}
                    onChange={(e) => setPending({ ...p, reason: e.target.value })}
                    placeholder="Lý do khóa (người dùng sẽ thấy)"
                    maxLength={255}
                  />
                  <div className="row-actions">
                    <button type="button" className="btn ghost sm" onClick={() => setPending(null)}>
                      Hủy
                    </button>
                    <button
                      type="button"
                      className="btn danger sm"
                      onClick={() => update(u.id, { isLocked: true, lockReason: p.reason })}
                    >
                      Khóa tài khoản
                    </button>
                  </div>
                </div>
              ) : p?.kind === "revoke" ? (
                <div className="confirm">
                  <p>Đăng xuất tài khoản này khỏi mọi thiết bị?</p>
                  <div className="row-actions">
                    <button type="button" className="btn ghost sm" onClick={() => setPending(null)}>
                      Hủy
                    </button>
                    <button type="button" className="btn danger sm" onClick={() => update(u.id, { revokeSessions: true })}>
                      Đăng xuất
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row-actions">
                  {self ? null : u.isLocked ? (
                    <button type="button" className="btn ghost sm" onClick={() => update(u.id, { isLocked: false })}>
                      Mở khóa
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn ghost sm danger-text"
                      onClick={() => setPending({ id: u.id, kind: "lock", reason: "" })}
                    >
                      Khóa
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setPending({ id: u.id, kind: "revoke" })}
                  >
                    Đăng xuất thiết bị
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {data && data.users.length === 0 ? <p className="hint">Không có tài khoản.</p> : null}
        {!data && !error ? <p className="hint">Đang tải…</p> : null}
      </div>

      {data && data.total > data.perPage ? (
        <div className="pager">
          <button type="button" className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Trước
          </button>
          <span className="muted">Trang {data.page}</span>
          <button
            type="button"
            className="btn ghost sm"
            disabled={data.page * data.perPage >= data.total}
            onClick={() => setPage(page + 1)}
          >
            Sau ›
          </button>
        </div>
      ) : null}
    </>
  );
}

function AuditTab({ guard }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    adminApi
      .audit()
      .then((d) => setEntries(d.entries))
      .catch((e) => guard(e, setError));
  }, [guard]);

  useEffect(load, [load]);

  return (
    <>
      <div className="row-actions end">
        <button type="button" className="btn ghost sm" onClick={load}>
          Tải lại
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="audit-list">
        {entries?.map((a) => (
          <div key={a.id} className="audit-row">
            <span className="audit-what">
              <strong>{ACTION_LABEL[a.action] || a.action}</strong> {a.target}
              {a.detail ? <span className="muted"> · {a.detail}</span> : null}
            </span>
            <span className="muted audit-when">
              {a.createdAt} · {a.actor || "hệ thống"}
              {a.ip ? ` · ${a.ip}` : ""}
            </span>
          </div>
        ))}
        {entries && entries.length === 0 ? <p className="hint">Chưa có thao tác nào.</p> : null}
        {!entries && !error ? <p className="hint">Đang tải…</p> : null}
      </div>
    </>
  );
}
