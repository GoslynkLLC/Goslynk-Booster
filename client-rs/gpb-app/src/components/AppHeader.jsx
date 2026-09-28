import logo from "../assets/goslynk-mark.png";

const ROLE_LABEL = { admin: "Admin", developer: "Developer", vip: "VIP", user: "Thành viên" };

/** "2026-10-05 23:50:00" (server time) as "05/10/2026". */
function shortDate(s) {
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : s;
}

export default function AppHeader({
  user,
  tab,
  onTab,
  boostedCount,
  maxSlots,
  onAdmin,
  onAdminRedeem,
  onLogout,
  onOpenRedeemModal,
}) {
  const name = user.displayName || user.username;
  const vipTitle = user.vipUntil ? `VIP đến ${shortDate(user.vipUntil)}` : undefined;
  return (
    <header className="app-header">
      <div className="app-brand">
        <img src={logo} alt="" />
        <span>Goslynk Booster</span>
      </div>

      <nav className="nav-tabs" aria-label="Điều hướng">
        <button
          type="button"
          className={`nav-tab${tab === "home" ? " active" : ""}`}
          aria-current={tab === "home" ? "page" : undefined}
          onClick={() => onTab("home")}
        >
          Home
          {boostedCount ? (
            <span className="nav-count">
              {boostedCount}/{maxSlots}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={`nav-tab${tab === "games" ? " active" : ""}`}
          aria-current={tab === "games" ? "page" : undefined}
          onClick={() => onTab("games")}
        >
          Games
        </button>
      </nav>

      <div className="profile">
        <span className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="profile-text">
          <span className="profile-name">{name}</span>
          <span className={`role-badge ${user.role}`} title={vipTitle}>
            {ROLE_LABEL[user.role] || user.role}
          </span>
        </span>
        <button type="button" className="btn ghost sm accent-text" onClick={onOpenRedeemModal}>
          Nhập code
        </button>
        {onAdmin ? (
          <button type="button" className="btn ghost sm" onClick={onAdmin}>
            Quản trị
          </button>
        ) : null}
        {onAdminRedeem ? (
          <button type="button" className="btn ghost sm" onClick={onAdminRedeem}>
            Mã quà
          </button>
        ) : null}
        <button type="button" className="btn ghost sm" onClick={onLogout}>
          Đăng xuất
        </button>
      </div>
    </header>
  );
}
