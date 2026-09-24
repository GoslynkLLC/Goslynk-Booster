export default function HomeScreen({
  user,
  games,
  selected,
  onSelect,
  onLogout,
  onBoost,
}) {
  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>Chọn game</h1>
          <p className="tag">
            Xin chào, <strong>{user.displayName || user.username}</strong>
          </p>
        </div>
        <button type="button" className="btn ghost sm" onClick={onLogout}>
          Đăng xuất
        </button>
      </header>

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

      <button
        type="button"
        className="btn primary"
        disabled={!selected}
        onClick={onBoost}
      >
        Giảm ping
      </button>
      <p className="hint muted">Mặc định: Liên Minh Huyền Thoại</p>
    </section>
  );
}
