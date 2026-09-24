import { useState } from "react";
import { apiRegister, errMsg } from "../api.js";

export default function RegisterScreen({ onSuccess, onGoLogin }) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    if (password !== password2) {
      setError("Mật khẩu nhập lại không khớp.");
      return;
    }
    setBusy(true);
    try {
      const user = await apiRegister(username.trim(), password, displayName.trim());
      onSuccess(user);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen">
      <header className="brand">
        <h1>Tạo tài khoản</h1>
        <p className="tag">Đăng ký · lưu trên máy (MVP)</p>
      </header>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Tên hiển thị
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Tuỳ chọn"
          />
        </label>
        <label>
          Tên đăng nhập
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            autoComplete="username"
          />
        </label>
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete="new-password"
          />
        </label>
        <label>
          Nhập lại mật khẩu
          <input
            type="password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            required
            minLength={6}
            autoComplete="new-password"
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Đang tạo…" : "Đăng ký"}
        </button>
        <button type="button" className="btn ghost" onClick={onGoLogin} disabled={busy}>
          Quay lại đăng nhập
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
