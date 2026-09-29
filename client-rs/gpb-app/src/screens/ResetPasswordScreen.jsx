import { useState } from "react";
import { apiResetPassword, errMsg } from "../api.js";
import logo from "../assets/goslynk-mark.png";

export default function ResetPasswordScreen({
  token,
  email,
  onSuccess,
  onGoLogin,
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("Không có mã đặt lại mật khẩu.");
      return;
    }

    if (password.length < 8) {
      setError("Mật khẩu phải có ít nhất 8 ký tự.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }

    setBusy(true);

    try {
      const data = await apiResetPassword(token, password);

      onSuccess?.(
        data.message ||
          "Đặt lại mật khẩu thành công. Vui lòng đăng nhập lại.",
      );
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

        <h1>Đặt mật khẩu mới</h1>

        <p className="tag">
          {email
            ? `Tài khoản: ${email}`
            : "Nhập mật khẩu mới cho tài khoản của bạn"}
        </p>
      </header>

      <form className="form" onSubmit={onSubmit}>
        <label>
          Mật khẩu mới
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            maxLength={200}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>

        <label>
          Xác nhận mật khẩu mới
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            maxLength={200}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>

        <button
          type="submit"
          className="btn primary"
          disabled={busy}
        >
          {busy
            ? "Đang đặt lại mật khẩu…"
            : "Đặt mật khẩu mới"}
        </button>
      </form>

      <p className="hint">
        <button
          type="button"
          className="link"
          onClick={onGoLogin}
          disabled={busy}
        >
          Quay lại đăng nhập
        </button>
      </p>

      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}