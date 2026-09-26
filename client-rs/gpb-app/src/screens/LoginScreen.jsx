import { useState } from "react";
import { apiLogin, errMsg } from "../api.js";
import logo from "../assets/goslynk-mark.png";

export default function LoginScreen({ onSuccess, onGoRegister }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await apiLogin(username.trim(), password);
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
        <img className="brand-logo" src={logo} alt="" />
        <h1>Goslynk Booster</h1>
        <p className="tag">Giảm ping · Đăng nhập</p>
      </header>
      <form className="form" onSubmit={onSubmit}>
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
            autoComplete="current-password"
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Đang đăng nhập…" : "Đăng nhập"}
        </button>
      </form>
      <p className="hint">
        Chưa có tài khoản?{" "}
        <button type="button" className="link" onClick={onGoRegister}>
          Đăng ký
        </button>
      </p>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
