import { useState } from "react";
import { apiRegister, errMsg } from "../api.js";
import logo from "../assets/goslynk-mark.png";

export default function RegisterScreen({ onSuccess, onBlocked, onGoLogin }) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
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
      const data = await apiRegister({
        username: username.trim(),
        email: email.trim(),
        password,
        displayName: displayName.trim(),
      });
      if (data.blocked) onBlocked(`Đã tạo tài khoản. ${data.blocked.message}`);
      else onSuccess(data);
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
        <h1>Tạo tài khoản</h1>
        <p className="tag">Goslynk Booster · Đăng ký</p>
      </header>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Tên hiển thị
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Tuỳ chọn" maxLength={64} />
        </label>
        <label>
          Tên đăng nhập
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            pattern="[A-Za-z0-9_.]{3,32}"
            title="3-32 ký tự: chữ, số, dấu chấm, gạch dưới"
            autoComplete="username"
          />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
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
            minLength={8}
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
