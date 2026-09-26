import { useMemo, useState } from "react";
import { GAME_ART, isLive, matchesQuery } from "../games.js";

const BADGE = {
  on: { text: "Đang boost", cls: " on" },
  connecting: { text: "Đang kết nối…", cls: " busy" },
  stopping: { text: "Đang dừng…", cls: " busy" },
  error: { text: "Lỗi", cls: " err" },
};

export default function GamesScreen({ games, slotState, errors, full, notice, onPick }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => games.filter((g) => matchesQuery(g, query)), [games, query]);

  return (
    <section className="screen">
      <div className="page-head">
        <div>
          <h1 className="page-title">Games</h1>
          <p className="tag">Bấm vào game để boost ngay · tối đa 3 game cùng lúc</p>
        </div>
        <label className="search">
          <span className="sr-only">Tìm game</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm game, ví dụ: lien minh, cs2…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      {notice ? <p className="notice warn">{notice}</p> : null}
      {games
        .filter((g) => slotState(g.id) === "error" && errors[g.id])
        .map((g) => (
          <p key={g.id} className="error">
            {g.name}: {errors[g.id]}
          </p>
        ))}

      {shown.length === 0 ? (
        <p className="empty-state">Không có game nào khớp “{query}”.</p>
      ) : (
        <div className="game-grid">
          {shown.map((g) => {
            const live = isLive(g);
            const state = slotState(g.id);
            const active = state !== "off";
            const blocked = !live || (full && !active);
            const art = GAME_ART[g.id];
            const badge = live ? BADGE[state] : null;
            return (
              <button
                key={g.id}
                type="button"
                className={`game-tile${state === "on" ? " boosted" : ""}${
                  state === "connecting" || state === "stopping" ? " busy" : ""
                }${live ? "" : " pending"}${blocked && live ? " full" : ""}`}
                aria-disabled={blocked}
                title={
                  !live
                    ? "Chưa có dải IP máy chủ để tăng tốc"
                    : state === "on"
                      ? "Đang boost · mở Home để xem ping"
                      : full && !active
                        ? "Đã đủ 3 slot · dừng một game ở Home trước"
                        : `Boost ${g.nameVi || g.name}`
                }
                onClick={() => live && onPick(g)}
              >
                {art ? (
                  <img
                    className="game-art"
                    src={art.src}
                    alt=""
                    style={{ objectPosition: art.focus }}
                    draggable={false}
                  />
                ) : null}
                <span className="game-shade" />
                {badge ? <span className={`game-badge${badge.cls}`}>{badge.text}</span> : null}
                <span className="game-info">
                  <span className="game-title">{g.name}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
