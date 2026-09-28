import { useState } from "react";
import { apiRedeemCode, errMsg } from "../api.js";

export default function RedeemModal({ onClose, onRedeemed }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function submit(e) {
    e.preventDefault();
    const clean = code.trim().toUpperCase();
    if (!clean) return;
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const res = await apiRedeemCode(clean);
      setSuccess(res.message || "Đã nhận quà.");
      setCode("");
      onRedeemed?.();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Nhập mã quà tặng</h3>
          <button type="button" className="modal-close" aria-label="Đóng" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <p className="hint muted">Mỗi mã chỉ nhận được một lần trên mỗi tài khoản và mỗi máy.</p>
          <label>
            Mã code
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="VD: GOSLYNK2026"
              maxLength={64}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          {error ? <p className="modal-message error">{error}</p> : null}
          {success ? <p className="modal-message success">{success}</p> : null}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              {success ? "Đóng" : "Hủy"}
            </button>
            <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
              {busy ? "Đang kiểm tra…" : "Nhận quà"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
