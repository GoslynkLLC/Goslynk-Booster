import { useEffect, useRef, useState } from "react";
import logo from "../assets/goslynk-mark.png";
import { ROLE_LABEL, vipLines } from "../format.js";

export default function AppHeader({
  user,
  tab,
  onTab,
  boostedCount,
  maxSlots,
  onProfile,
  onRedeem,
  onAdmin,
  onLogout,
}) {
  const name = user.displayName || user.username;
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn) => () => {
    setOpen(false);
    fn();
  };

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

      <div className="profile-menu" ref={menuRef}>
        <button
          type="button"
          className={`profile${open ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="avatar" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="profile-text">
            <span className="profile-name">{name}</span>
            <span className={`role-badge ${user.role}`}>{ROLE_LABEL[user.role] || user.role}</span>
          </span>
          <span className="caret" aria-hidden="true" />
        </button>

        {open ? (
          <div className="menu" role="menu">
            <div className="menu-head">
              <span className="menu-name">{name}</span>
              <span className="muted">@{user.username}</span>
              {vipLines(user).map((line) => (
                <span key={line} className="menu-vip">
                  {line}
                </span>
              ))}
            </div>
            <button type="button" role="menuitem" onClick={pick(onProfile)}>
              Hồ sơ
            </button>
            <button type="button" role="menuitem" onClick={pick(onRedeem)}>
              Nhập code
            </button>
            {onAdmin ? (
              <button type="button" role="menuitem" onClick={pick(onAdmin)}>
                Quản trị
              </button>
            ) : null}
            <hr />
            <button type="button" role="menuitem" className="danger-text" onClick={pick(onLogout)}>
              Đăng xuất
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
