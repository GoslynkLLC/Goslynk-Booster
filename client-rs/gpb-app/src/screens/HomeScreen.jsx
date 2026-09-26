const ROLE_LABEL = { admin: "Admin", developer: "Developer", vip: "VIP", user: "Thành viên" };

export default function HomeScreen({
  user,
  developerMode,
  games,
  selected,
  onSelect,
  onLogout,
  onAdmin,
  onBoost,
}) {
  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>Chọn game</h1>
          <p className="tag">
            Xin chào, <strong>{user.displayName || user.username}</strong>
            <span className={`role-badge ${user.role}`}>{ROLE_LABEL[user.role] || user.role}</span>
          </p>
        </div>
        <div className="row-actions">
          {onAdmin ? (
            <button type="button" className="btn ghost sm" onClick={onAdmin}>
              Quản trị
            </button>
          ) : null}
          <button type="button" className="btn ghost sm" onClick={onLogout}>
            Đăng xuất
          </button>
        </div>
      </header>

      {developerMode ? (
        <p className="notice warn">Chế độ developer đang bật: chỉ admin và developer vào được app.</p>
      ) : null}

      <div className="game-list" role="listbox" aria-label="Danh sách game">
        {games.map((g) => {
          const active = selected?.id === g.id;
          return (
            <button
              key={g.id}
              type="button"
              role="option"
              aria-selected={active}
              className={`game-card${active ? " selected" : ""}`}
              onClick={() => onSelect(g)}
            >
              <span className="game-name">{g.nameVi}</span>
              <span className="game-sub">
                {g.name}
                {g.isDefault ? " · mặc định" : ""}
              </span>
            </button>
          );
        })}
      </div>

      <button type="button" className="btn primary" disabled={!selected} onClick={onBoost}>
        Giảm ping
      </button>
      <p className="hint muted">Mặc định: Liên Minh Huyền Thoại</p>
    </section>
  );
}
