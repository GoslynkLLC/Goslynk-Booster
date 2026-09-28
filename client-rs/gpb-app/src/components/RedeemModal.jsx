import { useState } from "react";
import { apiRedeemCode, errMsg } from "../api.js";

export default function RedeemModal({ onClose, onSuccess }) {
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    async function handleSubmit(e) {
        e.preventDefault();
        const cleanCode = code.trim().toUpperCase();
        if (!cleanCode) return;

        setError("");
        setSuccess("");
        setLoading(true);

        try {
            const res = await apiRedeemCode(cleanCode);
            setSuccess(res.message || "Đã nhận quà thành công!");
            setCode("");
            if (onSuccess) onSuccess(res);
        } catch (err) {
            setError(errMsg(err));
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>🎁 Nhập Mã Quà Tặng</h3>
                    <button type="button" className="btn-close" onClick={onClose}>
                        ✕
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="modal-body">
                    <p className="hint">Mỗi mã quà tặng chỉ được áp dụng 1 lần duy nhất trên máy tính này.</p>

                    <label className="field-label">
                        Mã Code:
                        <input
                            type="text"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="VD: GOSLYNK2026"
                            autoFocus
                            autoComplete="off"
                            disabled={loading}
                            style={{ textTransform: "uppercase", letterSpacing: "1px", fontWeight: "bold" }}
                        />
                    </label>

                    {error ? <p className="notice err">{error}</p> : null}
                    {success ? <p className="notice ok">{success}</p> : null}

                    <div className="modal-actions">
                        <button type="button" className="btn ghost" onClick={onClose} disabled={loading}>
                            Hủy
                        </button>
                        <button type="submit" className="btn primary" disabled={loading || !code.trim()}>
                            {loading ? "Đang kiểm tra…" : "Xác nhận Nhận quà"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
