import { useEffect, useState } from "react";
import { adminRedeemApi, errMsg } from "../api.js";

export default function AdminRedeemScreen({ onBack }) {
    const [codes, setCodes] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Create Modal state
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newCode, setNewCode] = useState("");
    const [rewardValue, setRewardValue] = useState(7);
    const [maxUses, setMaxUses] = useState(0);
    const [expiresAt, setExpiresAt] = useState("");
    const [creating, setCreating] = useState(false);

    // Edit Modal state
    const [editingCode, setEditingCode] = useState(null);
    const [editRewardValue, setEditRewardValue] = useState(7);
    const [editMaxUses, setEditMaxUses] = useState(0);
    const [editExpiresAt, setEditExpiresAt] = useState("");
    const [editIsActive, setEditIsActive] = useState(1);
    const [updating, setUpdating] = useState(false);

    useEffect(() => {
        loadData();
    }, []);

    async function loadData() {
        try {
            const res = await adminRedeemApi.list();
            if (res && res.codes) {
                const sorted = [...res.codes].sort((a, b) => {
                    const aExpired = a.expires_at && new Date(a.expires_at).getTime() < Date.now() ? 1 : 0;
                    const bExpired = b.expires_at && new Date(b.expires_at).getTime() < Date.now() ? 1 : 0;
                    if (a.is_active !== b.is_active) return b.is_active - a.is_active;
                    if (aExpired !== bExpired) return aExpired - bExpired;
                    return b.id - a.id;
                });
                setCodes(sorted);
            }
        } catch (e) {
            // Khi dùng mock UI giữ nguyên mock data
        }
    }

    async function handleCreateCode(e) {
        e.preventDefault();
        const clean = newCode.trim().toUpperCase();
        if (!clean) return;

        setCreating(true);
        try {
            await adminRedeemApi.create({
                code: clean,
                rewardType: "vip_days",
                rewardValue: Number(rewardValue),
                maxUses: Number(maxUses),
                expiresAt: expiresAt || null,
            });
            setNewCode("");
            setExpiresAt("");
            setShowCreateModal(false);
            loadData();
        } catch (e) {
            alert(errMsg(e));
        } finally {
            setCreating(false);
        }
    }

    function openEditModal(item) {
        setEditingCode(item);
        setEditRewardValue(item.reward_value);
        setEditMaxUses(item.max_uses);
        setEditExpiresAt(item.expires_at ? item.expires_at.split("T")[0] : "");
        setEditIsActive(item.is_active);
    }

    async function handleUpdateCode(e) {
        e.preventDefault();
        if (!editingCode) return;

        setUpdating(true);
        try {
            await adminRedeemApi.update(editingCode.id, {
                rewardValue: Number(editRewardValue),
                maxUses: Number(editMaxUses),
                expiresAt: editExpiresAt || null,
                isActive: Number(editIsActive),
            });
            setEditingCode(null);
            loadData();
        } catch (e) {
            alert(errMsg(e));
        } finally {
            setUpdating(false);
        }
    }

    async function handleDeleteCode(id) {
        if (!confirm("Bạn có chắc chắn muốn thay đổi trạng thái (Khóa / Mở) mã code này?")) return;
        try {
            await adminRedeemApi.delete(id);
            loadData();
        } catch (e) {
            alert(errMsg(e));
        }
    }

    return (
        <section className="screen wide">
            <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <h1 className="page-title">Quản lý Mã Quà Tặng (Redeem Codes)</h1>
                    <p className="tag">Tạo mã quà tặng mới và quản lý lượt sử dụng theo HWID máy tính</p>
                </div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <button type="button" className="btn primary" onClick={() => setShowCreateModal(true)} style={{ padding: "8px 16px", fontWeight: "600" }}>
                        + Tạo Mã Mới
                    </button>
                    <button type="button" className="btn ghost" onClick={onBack}>
                        ← Quay lại Trang chủ
                    </button>
                </div>
            </div>

            {/* BẢNG DANH SÁCH MÃ CODE */}
            <div className="stats" style={{ marginTop: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                    <p className="section-title" style={{ margin: 0 }}>📋 Danh sách Mã hiện có trong hệ thống</p>
                    <span style={{ fontSize: "12px", color: "var(--muted)" }}>Tổng số: <strong>{codes.length}</strong> mã</span>
                </div>

                <div style={{ overflowX: "auto" }}>
                    <table className="admin-table" style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line)" }}>
                                <th style={{ padding: "12px" }}>Mã Code</th>
                                <th style={{ padding: "12px" }}>Phần thưởng</th>
                                <th style={{ padding: "12px" }}>Đã dùng / Tối đa</th>
                                <th style={{ padding: "12px" }}>Hạn sử dụng</th>
                                <th style={{ padding: "12px" }}>Trạng thái</th>
                                <th style={{ padding: "12px", textAlign: "right" }}>Thao tác</th>
                            </tr>
                        </thead>
                        <tbody>
                            {codes.length === 0 ? (
                                <tr>
                                    <td colSpan={6} style={{ padding: "20px", textAlign: "center" }} className="muted">
                                        Chưa có mã quà tặng nào. Bấm nút <strong>"+ Tạo Mã Mới"</strong> ở góc trên để tạo.
                                    </td>
                                </tr>
                            ) : (
                                codes.map((item) => {
                                    const isExpired = item.expires_at && new Date(item.expires_at).getTime() < Date.now();
                                    return (
                                        <tr key={item.id} style={{ borderBottom: "1px solid var(--line)", opacity: item.is_active === 0 || isExpired ? 0.6 : 1 }}>
                                            <td style={{ padding: "12px" }}>
                                                <strong
                                                    onClick={() => openEditModal(item)}
                                                    style={{
                                                        color: item.is_active === 0 || isExpired ? "var(--muted)" : "var(--accent)",
                                                        fontSize: "1.05rem",
                                                        cursor: "pointer",
                                                        textDecoration: "underline"
                                                    }}
                                                    title="Bấm để chỉnh sửa mã này"
                                                >
                                                    {item.code}
                                                </strong>
                                            </td>
                                            <td style={{ padding: "12px" }}>+{item.reward_value} ngày VIP</td>
                                            <td style={{ padding: "12px" }}>
                                                {item.used_count} / {item.max_uses === 0 ? "Vô hạn" : item.max_uses}
                                            </td>
                                            <td style={{ padding: "12px" }} className="muted">
                                                {item.expires_at ? new Date(item.expires_at).toLocaleDateString() : "Vĩnh viễn"}
                                            </td>
                                            <td style={{ padding: "12px" }}>
                                                {isExpired ? (
                                                    <span style={{ color: "#e67e22", fontSize: "12px", background: "rgba(230,126,34,0.15)", padding: "2px 8px", borderRadius: "4px" }}>Đã hết hạn</span>
                                                ) : item.is_active === 1 ? (
                                                    <span style={{ color: "#2ecc71", fontSize: "12px", background: "rgba(46,204,113,0.15)", padding: "2px 8px", borderRadius: "4px" }}>Đang mở</span>
                                                ) : (
                                                    <span style={{ color: "#e74c3c", fontSize: "12px", background: "rgba(231,76,60,0.15)", padding: "2px 8px", borderRadius: "4px" }}>Đã khóa</span>
                                                )}
                                            </td>
                                            <td style={{ padding: "12px", textAlign: "right" }}>
                                                <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                                                    {/* 1. Nút Chỉnh sửa (Icon chì ✏️) */}
                                                    <button
                                                        type="button"
                                                        className="btn ghost sm"
                                                        onClick={() => openEditModal(item)}
                                                        title="Chỉnh sửa mã code"
                                                        style={{ padding: "4px 8px", fontSize: "14px" }}
                                                    >
                                                        ✏️
                                                    </button>
                                                    {/* 2. Nút Khóa / Mở (Icon ✕ hoặc 🔓) */}
                                                    <button
                                                        type="button"
                                                        className={`btn ${item.is_active === 1 ? "err" : "ghost"} sm`}
                                                        onClick={() => handleDeleteCode(item.id)}
                                                        title={item.is_active === 1 ? "Vô hiệu hóa mã code" : "Kích hoạt lại mã code"}
                                                        style={{ padding: "4px 8px", fontSize: "14px" }}
                                                    >
                                                        {item.is_active === 1 ? "✕" : "🔓"}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* POPUP MODAL TẠO MÃ CODE MỚI */}
            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "480px" }}>
                        <div className="modal-header">
                            <h3>➕ Tạo Mã Quà Tặng Mới</h3>
                            <button type="button" className="modal-close" onClick={() => setShowCreateModal(false)}>×</button>
                        </div>

                        <form onSubmit={handleCreateCode} className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Mã Code:</span>
                                <input
                                    type="text"
                                    placeholder="Nhập code (VD: GOSLYNK2026)"
                                    value={newCode}
                                    onChange={(e) => setNewCode(e.target.value)}
                                    style={{ textTransform: "uppercase", fontWeight: "bold", padding: "10px" }}
                                    autoFocus
                                />
                            </label>

                            <div style={{ display: "flex", gap: "12px" }}>
                                <label style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                                    <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Số ngày VIP:</span>
                                    <input
                                        type="number"
                                        placeholder="7"
                                        value={rewardValue}
                                        onChange={(e) => setRewardValue(e.target.value)}
                                        style={{ padding: "10px" }}
                                    />
                                </label>

                                <label style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                                    <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Lượt dùng (0 = Vô hạn):</span>
                                    <input
                                        type="number"
                                        placeholder="0"
                                        value={maxUses}
                                        onChange={(e) => setMaxUses(e.target.value)}
                                        style={{ padding: "10px" }}
                                    />
                                </label>
                            </div>

                            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Hạn sử dụng (Để trống = Vĩnh viễn):</span>
                                <input
                                    type="date"
                                    value={expiresAt}
                                    onChange={(e) => setExpiresAt(e.target.value)}
                                    style={{ padding: "10px" }}
                                />
                            </label>

                            <div className="modal-actions" style={{ marginTop: "10px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                                <button type="button" className="btn ghost" onClick={() => setShowCreateModal(false)}>
                                    Hủy
                                </button>
                                <button type="submit" className="btn primary" disabled={creating || !newCode.trim()}>
                                    {creating ? "Đang tạo…" : "+ Tạo Mã"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* POPUP MODAL CHỈNH SỬA MÃ CODE */}
            {editingCode && (
                <div className="modal-overlay" onClick={() => setEditingCode(null)}>
                    <div className="modal-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "480px" }}>
                        <div className="modal-header">
                            <h3>✏️ Chỉnh sửa Mã: <span style={{ color: "var(--accent)" }}>{editingCode.code}</span></h3>
                            <button type="button" className="modal-close" onClick={() => setEditingCode(null)}>×</button>
                        </div>

                        <form onSubmit={handleUpdateCode} className="modal-body" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Mã Code (Cố định):</span>
                                <input
                                    type="text"
                                    value={editingCode.code}
                                    disabled
                                    style={{ textTransform: "uppercase", fontWeight: "bold", padding: "10px", opacity: 0.6, background: "rgba(255,255,255,0.05)" }}
                                />
                            </label>

                            <div style={{ display: "flex", gap: "12px" }}>
                                <label style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                                    <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Số ngày VIP:</span>
                                    <input
                                        type="number"
                                        value={editRewardValue}
                                        onChange={(e) => setEditRewardValue(e.target.value)}
                                        style={{ padding: "10px" }}
                                    />
                                </label>

                                <label style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                                    <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Lượt dùng (0 = Vô hạn):</span>
                                    <input
                                        type="number"
                                        value={editMaxUses}
                                        onChange={(e) => setEditMaxUses(e.target.value)}
                                        style={{ padding: "10px" }}
                                    />
                                </label>
                            </div>

                            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Hạn sử dụng (Để trống = Vĩnh viễn):</span>
                                <input
                                    type="date"
                                    value={editExpiresAt}
                                    onChange={(e) => setEditExpiresAt(e.target.value)}
                                    style={{ padding: "10px" }}
                                />
                            </label>

                            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                <span style={{ fontSize: "13px", color: "var(--muted)", fontWeight: "500" }}>Trạng thái:</span>
                                <select
                                    value={editIsActive}
                                    onChange={(e) => setEditIsActive(Number(e.target.value))}
                                    style={{ padding: "10px" }}
                                >
                                    <option value={1}>🟢 Đang mở (Được phép sử dụng)</option>
                                    <option value={0}>🔴 Đã khóa (Vô hiệu hóa)</option>
                                </select>
                            </label>

                            <div className="modal-actions" style={{ marginTop: "10px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                                <button type="button" className="btn ghost" onClick={() => setEditingCode(null)}>
                                    Hủy
                                </button>
                                <button type="submit" className="btn primary" disabled={updating}>
                                    {updating ? "Đang lưu…" : "Lưu Thay Đổi"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </section>
    );
}
