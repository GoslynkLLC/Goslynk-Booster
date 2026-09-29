import { useState } from "react";
import { apiForgotPassword, errMsg } from "../api.js";
import logo from "../assets/goslynk-mark.png";

export default function ForgotPasswordScreen({
  onGoLogin,
  onCodeSent,
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();

    setError("");

    const normalizedEmail = email
      .trim()
      .toLowerCase();

    if (!normalizedEmail) {
      setError("Vui lòng nhập email.");
      return;
    }

    setBusy(true);

    try {
      const data = await apiForgotPassword(
        normalizedEmail,
      );

      const successMessage =
        data.message ||
        "Nếu email tồn tại trong hệ thống, mã xác nhận sẽ được gửi tới email đó.";

      onCodeSent?.({
        email: normalizedEmail,
        message: successMessage,

        expiresInSeconds: Number(
          data.expiresInSeconds ?? 900,
        ),

        resendAfterSeconds: Number(
          data.resendAfterSeconds ??
            data.expiresInSeconds ??
            900,
        ),
      });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen">
      <header className="brand">
        <img
          className="brand-logo"
          src={logo}
          alt=""
        />

        <h1>Quên mật khẩu</h1>

        <p className="tag">
          Nhập email đã đăng ký với Goslynk
        </p>
      </header>

      <form
        className="form"
        onSubmit={onSubmit}
      >
        <label>
          Email

          <input
            type="email"
            value={email}
            onChange={(e) =>
              setEmail(e.target.value)
            }
            required
            autoComplete="email"
            placeholder="email@example.com"
            disabled={busy}
          />
        </label>

        <button
          type="submit"
          className="btn primary"
          disabled={busy}
        >
          {busy
            ? "Đang gửi mã…"
            : "Gửi mã xác nhận"}
        </button>
      </form>

      {error ? (
        <p className="error">
          {error}
        </p>
      ) : null}

      <p className="hint">
        Đã nhớ mật khẩu?{" "}
        <button
          type="button"
          className="link"
          onClick={onGoLogin}
          disabled={busy}
        >
          Quay lại đăng nhập
        </button>
      </p>
    </section>
  );
}