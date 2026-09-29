import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  apiForgotPassword,
  apiVerifyResetCode,
  errMsg,
} from "../api.js";

import logo from "../assets/goslynk-mark.png";

function secondsUntil(timestamp, now) {
  if (!timestamp) {
    return 0;
  }

  return Math.max(
    0,
    Math.ceil((timestamp - now) / 1000),
  );
}

function formatTime(totalSeconds) {
  const seconds = Math.max(
    0,
    Number(totalSeconds) || 0,
  );

  const minutes = Math.floor(
    seconds / 60,
  );

  const rest = seconds % 60;

  return `${String(minutes).padStart(
    2,
    "0",
  )}:${String(rest).padStart(2, "0")}`;
}

function maskEmail(email) {
  if (!email || !email.includes("@")) {
    return email || "";
  }

  const [name, domain] = email.split("@");

  if (name.length <= 2) {
    return `${name[0] ?? "*"}***@${domain}`;
  }

  return `${name[0]}***${name.at(-1)}@${domain}`;
}

export default function VerifyResetCodeScreen({
  email,
  initialExpiresAt,
  initialResendAt,
  onVerified,
  onGoLogin,
}) {
  const [code, setCode] = useState("");

  const [busy, setBusy] =
    useState(false);

  const [resending, setResending] =
    useState(false);

  const [error, setError] =
    useState("");

  const [notice, setNotice] =
    useState("");

  const [now, setNow] =
    useState(Date.now());

  const [expiresAt, setExpiresAt] =
    useState(initialExpiresAt || 0);

  const [resendAt, setResendAt] =
    useState(initialResendAt || 0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const expiresLeft = useMemo(
    () =>
      secondsUntil(
        expiresAt,
        now,
      ),
    [expiresAt, now],
  );

  const resendLeft = useMemo(
    () =>
      secondsUntil(
        resendAt,
        now,
      ),
    [resendAt, now],
  );

  const codeExpired =
    expiresLeft <= 0;

  const canResend =
    resendLeft <= 0 &&
    !resending &&
    !busy;

  function handleCodeChange(e) {
    const value = e.target.value
      .replace(/\D/g, "")
      .slice(0, 6);

    setCode(value);
    setError("");
  }

  async function onSubmit(e) {
    e.preventDefault();

    setError("");
    setNotice("");

    if (!email) {
      setError(
        "Không tìm thấy email cần xác nhận.",
      );
      return;
    }

    if (codeExpired) {
      setError(
        "Mã xác nhận đã hết hạn. Vui lòng gửi lại mã mới.",
      );
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      setError(
        "Vui lòng nhập đầy đủ mã xác nhận 6 số.",
      );
      return;
    }

    setBusy(true);

    try {
      const data =
        await apiVerifyResetCode(
          email,
          code,
        );

      if (!data?.resetToken) {
        throw new Error(
          "Server không trả về reset token.",
        );
      }

      onVerified?.({
        token: data.resetToken,
        email,
      });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (!canResend) {
      return;
    }

    setError("");
    setNotice("");
    setResending(true);

    try {
      const data =
        await apiForgotPassword(email);

      const currentTime = Date.now();

      const expiresInSeconds = Math.max(
        0,
        Number(
          data.expiresInSeconds ?? 900,
        ),
      );

      const resendAfterSeconds = Math.max(
        0,
        Number(
          data.resendAfterSeconds ??
            expiresInSeconds,
        ),
      );

      setExpiresAt(
        currentTime +
          expiresInSeconds * 1000,
      );

      setResendAt(
        currentTime +
          resendAfterSeconds * 1000,
      );

      setNow(currentTime);

      // OTP cũ không còn cần giữ.
      setCode("");

      setNotice(
        "Mã xác nhận mới đã được gửi tới email của bạn.",
      );
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setResending(false);
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

        <h1>Xác nhận mã</h1>

        <p className="tag">
          Nhập mã 6 số đã được gửi tới
        </p>

        {email ? (
          <p className="hint">
            {maskEmail(email)}
          </p>
        ) : null}
      </header>

      <form
        className="form"
        onSubmit={onSubmit}
      >
        <label>
          Mã xác nhận

          <input
            type="text"
            value={code}
            onChange={handleCodeChange}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            required
            disabled={
              busy ||
              resending ||
              codeExpired
            }
            autoFocus
          />
        </label>

        <p className="hint">
          {codeExpired ? (
            <>
              Mã xác nhận đã hết hạn.
            </>
          ) : (
            <>
              Mã còn hiệu lực:{" "}
              <strong>
                {formatTime(
                  expiresLeft,
                )}
              </strong>
            </>
          )}
        </p>

        <button
          type="submit"
          className="btn primary"
          disabled={
            busy ||
            resending ||
            code.length !== 6 ||
            codeExpired
          }
        >
          {busy
            ? "Đang xác nhận…"
            : "Xác nhận mã"}
        </button>
      </form>

      {notice ? (
        <p className="notice">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p className="error">
          {error}
        </p>
      ) : null}

      <p className="hint">
        Chưa nhận được mã?{" "}

        {resendLeft > 0 ? (
          <span>
            Gửi lại sau{" "}
            <strong>
              {formatTime(
                resendLeft,
              )}
            </strong>
          </span>
        ) : (
          <button
            type="button"
            className="link"
            onClick={resendCode}
            disabled={!canResend}
          >
            {resending
              ? "Đang gửi…"
              : "Gửi lại mã"}
          </button>
        )}
      </p>

      <p className="hint">
        <button
          type="button"
          className="link"
          onClick={onGoLogin}
          disabled={
            busy ||
            resending
          }
        >
          Quay lại đăng nhập
        </button>
      </p>
    </section>
  );
}