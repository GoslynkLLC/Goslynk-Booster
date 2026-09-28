import { useCallback, useEffect, useState } from "react";
import { errMsg, isSessionRejected, profileApi } from "../api.js";
import { ROLE_LABEL, shortDate, shortDateTime, vipLines } from "../format.js";

export default function ProfileScreen({ user, onUpdated, onSessionRejected, onRedeem }) {
  const guard = useCallback(
    (e, setError) => {
      if (isSessionRejected(e)) onSessionRejected(e.message);
      else setError(errMsg(e));
    },
    [onSessionRejected],
  );
  const name = user.displayName || user.username;

  return (
    <section className="screen profile-screen">
      <div className="page-head">
        <div>
          <h1 className="page-title">Hồ sơ</h1>
          <p className="tag">Thông tin tài khoản, mật khẩu và thiết bị đăng nhập</p>
        </div>
      </div>

      <section className="panel profile-card">
        <span className="avatar lg" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="profile-card-text">
          <span className="profile-card-name">
            {name}
            <span className={`role-badge ${user.role}`}>{ROLE_LABEL[user.role] || user.role}</span>
          </span>
          <span className="muted">
            @{user.username}
            {user.createdAt ? ` · tham gia ${shortDate(user.createdAt)}` : ""}
          </span>
          <span className={user.canBoost ? "ok" : "hint"}>
            {vipLines(user, shortDateTime).join(" · ") ||
              (user.canBoost ? "Được boost game không giới hạn thời gian" : "Chưa có VIP: chưa boost được game")}
          </span>
        </div>
        <button type="button" className="btn primary sm" onClick={onRedeem}>
          Nhập code
        </button>
      </section>

      <InfoPanel user={user} guard={guard} onUpdated={onUpdated} />
      <PasswordPanel guard={guard} />
      <SessionsPanel guard={guard} deviceLimit={user.deviceLimit} />
    </section>
  );
}

function InfoPanel({ user, guard, onUpdated }) {
  const [displayName, setDisplayName] = useState(user.displayName === user.username ? "" : user.displayName);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");
  const emailChanged = email.trim().toLowerCase() !== user.email;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setOk("");
    setError("");
    try {
      const patch = { displayName: displayName.trim() };
      if (emailChanged) Object.assign(patch, { email: email.trim(), currentPassword: password });
      const data = await profileApi.update(patch);
      onUpdated(data);
      setEmail(data.user.email);
      setPassword("");
      setOk("Đã lưu thông tin.");
    } catch (err) {
      guard(err, setError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <p className="panel-title">Thông tin tài khoản</p>
      <label>
        Tên đăng nhập (không đổi được)
        <input value={user.username} disabled />
      </label>
      <label>
        Tên hiển thị
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={user.username}
          maxLength={64}
        />
      </label>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={191} />
      </label>
      {emailChanged ? (
        <label>
          Mật khẩu hiện tại (bắt buộc khi đổi email)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
      ) : null}
      {ok ? <p className="ok">{ok}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <button type="submit" className="btn primary sm" disabled={busy || (emailChanged && !password)}>
        {busy ? "Đang lưu…" : "Lưu thông tin"}
      </button>
    </form>
  );
}

function PasswordPanel({ guard }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");
  const mismatch = confirm && next !== confirm;

  async function save(e) {
    e.preventDefault();
    if (next !== confirm) return;
    setBusy(true);
    setOk("");
    setError("");
    try {
      const r = await profileApi.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setOk(r.signedOut ? `Đã đổi mật khẩu. ${r.signedOut} thiết bị khác đã bị đăng xuất.` : "Đã đổi mật khẩu.");
    } catch (err) {
      guard(err, setError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={save}>
      <div>
        <p className="panel-title">Đổi mật khẩu</p>
        <p className="hint">Các thiết bị khác sẽ bị đăng xuất, thiết bị này vẫn giữ đăng nhập.</p>
      </div>
      <label>
        Mật khẩu hiện tại
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
      </label>
      <div className="field-row">
        <label>
          Mật khẩu mới (tối thiểu 8 ký tự)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        <label>
          Nhập lại mật khẩu mới
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </label>
      </div>
      {mismatch ? <p className="error">Hai mật khẩu mới không khớp.</p> : null}
      {ok ? <p className="ok">{ok}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <button
        type="submit"
        className="btn primary sm"
        disabled={busy || !current || next.length < 8 || next !== confirm}
      >
        {busy ? "Đang đổi…" : "Đổi mật khẩu"}
      </button>
    </form>
  );
}

function SessionsPanel({ guard, deviceLimit }) {
  const [sessions, setSessions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    profileApi
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch((e) => guard(e, setError));
  }, [guard]);

  useEffect(load, [load]);

  async function revokeOthers() {
    setBusy(true);
    setOk("");
    setError("");
    try {
      const r = await profileApi.revokeOthers();
      setOk(`Đã đăng xuất ${r.signedOut} thiết bị khác.`);
      load();
    } catch (e) {
      guard(e, setError);
    } finally {
      setBusy(false);
    }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <section className="panel">
      <div>
        <p className="panel-title">Thiết bị đang đăng nhập</p>
        <p className="hint">
          {deviceLimit
            ? `Tài khoản của bạn đăng nhập được trên ${deviceLimit} thiết bị cùng lúc: đăng nhập thêm máy mới sẽ đăng xuất máy cũ nhất. Thành viên và VIP: 1 thiết bị, VIP+: 2.`
            : "Tài khoản của bạn đăng nhập được trên nhiều thiết bị cùng lúc."}
        </p>
      </div>
      {sessions === null ? (
        error ? null : <p className="hint">Đang tải…</p>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="session-device">
                {s.device || "Thiết bị không tên"}
                {s.current ? <span className="pill on">Thiết bị này</span> : null}
              </span>
              <span className="muted">
                {s.ip || "—"} · hoạt động {shortDateTime(s.lastSeenAt || s.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {ok ? <p className="ok">{ok}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <button type="button" className="btn ghost sm danger-text" disabled={busy || others === 0} onClick={revokeOthers}>
        Đăng xuất các thiết bị khác
      </button>
    </section>
  );
}
