import { useEffect, useRef, useState } from "react";
import { GAME_ART, detailLabel } from "../games.js";

const RELAY_SOURCE = {
  override: "relay thủ công",
  server: "relay máy chủ",
  build: "relay mặc định",
  none: "chưa có relay",
};

// With the tunnel up this long and no packet sent, no game is using the routed ranges.
const IDLE_HINT_MS = 15000;

const STATE_LABEL = {
  on: "Đang boost",
  connecting: "Đang kết nối…",
  stopping: "Đang dừng…",
  error: "Lỗi",
  off: "Đã dừng",
};

const ms = (v) => (v != null ? `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` : "—");

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function pingClass(v) {
  if (v == null) return "";
  if (v < 60) return " good";
  if (v < 120) return " warn";
  return " bad";
}

// Packets per second from two consecutive status samples.
function useRates(status) {
  const prev = useRef(null);
  const [rates, setRates] = useState({ up: 0, down: 0 });
  useEffect(() => {
    if (!status.connected) {
      prev.current = null;
      setRates({ up: 0, down: 0 });
      return;
    }
    const now = performance.now();
    const p = prev.current;
    if (p) {
      const dt = (now - p.at) / 1000;
      if (dt > 0.2) {
        setRates({
          up: Math.max(0, (status.packetsSent - p.sent) / dt),
          down: Math.max(0, (status.packetsReceived - p.received) / dt),
        });
      }
    }
    prev.current = { at: now, sent: status.packetsSent || 0, received: status.packetsReceived || 0 };
  }, [status]);
  return rates;
}

function useConnectedSince(connected) {
  const [since, setSince] = useState(null);
  useEffect(() => {
    setSince(connected ? Date.now() : null);
  }, [connected]);
  return since;
}

function Slot({ game, state, error, regionIds, onRegionsChange, onStop, onRetry, onRemove }) {
  const art = GAME_ART[game.id];
  const busy = state === "connecting" || state === "stopping";
  const regions = (game.regions || []).filter((r) => r.cidrCount > 0);
  const routed = regions.filter((r) => regionIds.includes(r.id)).reduce((n, r) => n + r.cidrCount, 0);

  function toggle(id) {
    const next = regionIds.includes(id) ? regionIds.filter((x) => x !== id) : [...regionIds, id];
    if (next.some((x) => regions.some((r) => r.id === x))) onRegionsChange(next);
  }

  return (
    <article className={`slot filled ${state}`}>
      <div className="slot-art">
        {art ? <img src={art.src} alt="" style={{ objectPosition: art.focus }} draggable={false} /> : null}
        <span className={`slot-state ${state}`}>{STATE_LABEL[state]}</span>
      </div>
      <div className="slot-body">
        <p className="slot-title">{game.nameVi || game.name}</p>
        <p className="slot-detail">{detailLabel(game)}</p>
        {error ? <p className="error slot-error">{error}</p> : null}

        <details className="slot-regions">
          <summary>
            Khu vực <span className="muted">· {routed} dải IP</span>
          </summary>
          {regions.map((r) => (
            <label key={r.id} className="check">
              <input
                type="checkbox"
                checked={regionIds.includes(r.id)}
                onChange={() => toggle(r.id)}
                disabled={busy}
              />
              <span>
                {r.name}
                <span className="muted"> · {r.cidrCount}</span>
              </span>
            </label>
          ))}
        </details>

        <div className="slot-actions">
          {state === "on" || busy ? (
            <button type="button" className="btn sm stop" onClick={onStop} disabled={busy}>
              {state === "stopping" ? "Đang dừng…" : state === "connecting" ? "Đang kết nối…" : "Dừng boost"}
            </button>
          ) : (
            <>
              <button type="button" className="btn primary sm" onClick={onRetry}>
                Boost lại
              </button>
              <button type="button" className="btn ghost sm" onClick={onRemove}>
                Bỏ
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

export default function HomeScreen({
  developerMode,
  games,
  slots,
  maxSlots,
  slotState,
  errors,
  status,
  regionIdsFor,
  onRegionsChange,
  onStop,
  onRetry,
  onRemove,
  onPickGames,
  relay,
  canEditRelay,
  relayOverride,
  onRelayOverrideChange,
}) {
  const rates = useRates(status);
  const connected = !!status.connected;
  const since = useConnectedSince(connected);
  const idle = connected && !status.packetsSent && since != null && Date.now() - since > IDLE_HINT_MS;
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const filled = slots.map((id) => byId[id]).filter(Boolean);
  const empty = Math.max(0, maxSlots - filled.length);
  const busy = filled.some((g) => ["connecting", "stopping"].includes(slotState(g.id)));

  return (
    <section className="screen">
      <div className="page-head">
        <div>
          <h1 className="page-title">Home</h1>
          <p className="tag">Boost tối đa {maxSlots} game cùng lúc qua một tunnel</p>
        </div>
      </div>

      {developerMode ? (
        <p className="notice warn">Chế độ developer đang bật: chỉ admin và developer vào được app.</p>
      ) : null}

      <div className="slots">
        {filled.map((g) => (
          <Slot
            key={g.id}
            game={g}
            state={slotState(g.id)}
            error={errors[g.id]}
            regionIds={regionIdsFor(g)}
            onRegionsChange={(ids) => onRegionsChange(g, ids)}
            onStop={() => onStop(g)}
            onRetry={() => onRetry(g)}
            onRemove={() => onRemove(g)}
          />
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <button key={`empty-${i}`} type="button" className="slot empty" onClick={onPickGames}>
            <span className="slot-plus" aria-hidden="true">
              +
            </span>
            <span className="slot-empty-title">Slot trống</span>
            <span className="muted">Chọn game để boost</span>
          </button>
        ))}
      </div>

      <section className="stats">
        <div className="stats-head">
          <p className="section-title">Kết nối</p>
          <span className={`conn-pill${connected ? " on" : ""}`}>
            {connected ? "Đã kết nối" : busy ? "Đang kết nối…" : "Chưa kết nối"}
          </span>
        </div>
        <div className="stat-grid">
          <div className="stat">
            <span className="label">Ping tới relay</span>
            <span className={`stat-value${pingClass(connected ? status.lastRttMs : null)}`}>
              {connected ? ms(status.lastRttMs) : "—"}
            </span>
            <span className="stat-sub">
              {connected ? `TB ${ms(status.avgRttMs)} · thấp nhất ${ms(status.minRttMs)}` : " "}
            </span>
          </div>
          <div className="stat">
            <span className="label">Jitter</span>
            <span className="stat-value">{connected ? ms(status.jitterMs) : "—"}</span>
            <span className="stat-sub">
              {connected && status.lossPct != null ? `Mất gói ${status.lossPct.toFixed(1)}%` : " "}
            </span>
          </div>
          <div className="stat">
            <span className="label">Gói game</span>
            <span className="stat-value">
              {connected ? `↑${Math.round(rates.up)} ↓${Math.round(rates.down)}` : "—"}
            </span>
            <span className="stat-sub">
              {!connected
                ? " "
                : status.redundant
                  ? `gói/s · gửi kép, cứu ${status.rescuedPackets || 0} gói mất`
                  : `gói/s · tổng ↑${status.packetsSent || 0} ↓${status.packetsReceived || 0}`}
            </span>
          </div>
          <div className="stat">
            <span className="label">Dữ liệu</span>
            <span className="stat-value">{connected ? `↓${bytes(status.bytesReceived)}` : "—"}</span>
            <span className="stat-sub">
              {connected ? `↑${bytes(status.bytesSent)} · ${status.innerIp || "—"}` : " "}
            </span>
          </div>
        </div>
        <p className="hint">
          {!connected
            ? "Bấm một game ở mục Games để bắt đầu boost."
            : idle
              ? "Chưa có gói game nào qua tunnel. Vào trận để game kết nối tới server khu vực đã chọn."
              : "Ping trong game ≈ ping tới relay + đoạn relay → server game."}
        </p>
      </section>

      {canEditRelay ? (
        <details className="config">
          <summary>
            Relay thủ công (developer)
            <span className="muted"> · đang dùng {RELAY_SOURCE[relay.source]}</span>
          </summary>
          <p className="hint">Để trống để dùng relay do admin cấu hình trên máy chủ. Áp dụng từ lần kết nối sau.</p>
          <label>
            Endpoint
            <input
              value={relayOverride.endpoint}
              onChange={(e) => onRelayOverrideChange({ ...relayOverride, endpoint: e.target.value })}
              placeholder={relay.endpoint || "203.0.113.10:51820"}
              autoComplete="off"
            />
          </label>
          <label>
            PSK
            <input
              type="password"
              value={relayOverride.psk}
              onChange={(e) => onRelayOverrideChange({ ...relayOverride, psk: e.target.value })}
              placeholder="≥ 16 ký tự"
              autoComplete="off"
            />
          </label>
        </details>
      ) : null}
    </section>
  );
}
