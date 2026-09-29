import { useState } from "react";
import { apiLogin, errMsg } from "../api.js";
import logo from "../assets/goslynk-mark.png";

export default function LoginScreen({ notice, onSuccess, onGoRegister, onGoForgotPassword }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onSuccess(await apiLogin(login.trim(), password));
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
      {notice && !error ? <p className="notice warn">{notice}</p> : null}
      <form className="form" onSubmit={onSubmit}>
        <label>
          Tên đăng nhập hoặc email
          <input value={login} onChange={(e) => setLogin(e.target.value)} required autoComplete="username" />
        </label>
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>

        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Đang đăng nhập…" : "Đăng nhập"}
        </button>

        <p className="hint">
          <button
            type="button"
            className="link"
            onClick={onGoForgotPassword}
            disabled={busy}
          >
            Quên mật khẩu?
          </button>
        </p>
        
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
