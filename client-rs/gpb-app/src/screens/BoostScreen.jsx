import { useEffect, useRef, useState } from "react";
import { apiConnect, apiDisconnect, apiGetStatus, errMsg } from "../api.js";

const RELAY_SOURCE = {
  override: "relay thủ công",
  server: "relay máy chủ",
  build: "relay mặc định",
  none: "chưa có relay",
};

const POLL_MS = 1000;
// With the tunnel up this long and no packet sent, the game is not using the routed ranges.
const IDLE_HINT_MS = 15000;

const ms = (v) => (v != null ? `${v < 10 ? v.toFixed(1) : Math.round(v)} ms` : "—");

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function pingClass(v) {
  if (v == null) return " muted";
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

export default function BoostScreen({
  game,
  regionIds,
  onRegionsChange,
  relay,
  canEditRelay,
  relayOverride,
  onRelayOverrideChange,
  onBack,
}) {
  const [status, setStatus] = useState({ connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectedAt, setConnectedAt] = useState(null);
  const rates = useRates(status);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await apiGetStatus();
        if (alive) setStatus(s);
      } catch {
        /* ignore poll errors */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function onToggle() {
    setError("");
    setBusy(true);
    try {
      if (status.connected) {
        await apiDisconnect();
        setStatus({ connected: false });
      } else {
        if (relay.source === "none") {
          throw new Error("Máy chủ chưa cấu hình relay. Liên hệ admin Goslynk.");
        }
        if (routedCount === 0) throw new Error("Chọn ít nhất một khu vực có dải IP.");
        const result = await apiConnect({
          psk: relay.psk,
          endpoint: relay.endpoint.trim(),
          gameId: game.id,
          regionIds,
        });
        setStatus({
          connected: true,
          innerIp: result.innerIp,
          handshakeRttMs: result.handshakeRttMs,
          packetsSent: 0,
          packetsReceived: 0,
        });
        setConnectedAt(Date.now());
      }
    } catch (e) {
      setError(errMsg(e));
      try {
        setStatus(await apiGetStatus());
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status.connected;
  const idle =
    connected &&
    !status.packetsSent &&
    connectedAt != null &&
    Date.now() - connectedAt > IDLE_HINT_MS;
  const regions = game.regions || [];
  const routedCount = regions
    .filter((r) => regionIds.includes(r.id))
    .reduce((n, r) => n + r.cidrCount, 0);

  function toggleRegion(id) {
    onRegionsChange(
      regionIds.includes(id) ? regionIds.filter((x) => x !== id) : [...regionIds, id],
    );
  }

  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>{game.nameVi}</h1>
          <p className="tag">{game.name}</p>
        </div>
        <button type="button" className="btn ghost sm" onClick={onBack} disabled={busy}>
          Menu
        </button>
      </header>

      <section className="status-card">
        <div className="status-row">
          <span className="label">Trạng thái</span>
          <span className={`value${connected ? " on" : " muted"}`}>
            {connected ? "Đã kết nối" : "Chưa kết nối"}
          </span>
        </div>
        <div className="status-row">
          <span className="label">Ping tới relay</span>
          <span className={`value ping${pingClass(connected ? status.lastRttMs : null)}`}>
            {connected ? ms(status.lastRttMs) : "—"}
          </span>
        </div>
        <div className="status-row sub">
          <span className="label">Trung bình · thấp nhất</span>
          <span className="value">
            {connected ? `${ms(status.avgRttMs)} · ${ms(status.minRttMs)}` : "—"}
          </span>
        </div>
        <div className="status-row sub">
          <span className="label">Jitter</span>
          <span className="value">{connected ? ms(status.jitterMs) : "—"}</span>
        </div>
        <div className="status-row sub">
          <span className="label">Mất gói</span>
          <span className={`value${status.lossPct > 2 ? " bad" : ""}`}>
            {connected && status.lossPct != null ? `${status.lossPct.toFixed(1)}%` : "—"}
          </span>
        </div>
        <div className="status-row">
          <span className="label">Gói game</span>
          <span className="value">
            ↑{status.packetsSent || 0} ↓{status.packetsReceived || 0}
          </span>
        </div>
        <div className="status-row sub">
          <span className="label">Tốc độ</span>
          <span className="value">
            {connected ? `↑${Math.round(rates.up)} ↓${Math.round(rates.down)} gói/s` : "—"}
          </span>
        </div>
        <div className="status-row sub">
          <span className="label">Dữ liệu</span>
          <span className="value">
            {connected ? `↑${bytes(status.bytesSent)} ↓${bytes(status.bytesReceived)}` : "—"}
          </span>
        </div>
        <div className="status-row sub">
          <span className="label">Inner IP · handshake</span>
          <span className="value">
            {connected ? `${status.innerIp || "—"} · ${ms(status.handshakeRttMs)}` : "—"}
          </span>
        </div>
        {connected ? (
          <p className="hint">
            {idle
              ? "Chưa có gói game nào qua tunnel. Vào trận để game kết nối tới server khu vực đã chọn."
              : "Ping trong game ≈ ping tới relay + đoạn relay → server game."}
          </p>
        ) : null}
      </section>

      <section className="config regions">
        <p className="section-title">
          Khu vực server
          <span className="muted"> · {routedCount} dải IP</span>
        </p>
        {regions.map((r) => (
          <label key={r.id} className={`region${r.cidrCount === 0 ? " empty" : ""}`}>
            <input
              type="checkbox"
              checked={regionIds.includes(r.id)}
              onChange={() => toggleRegion(r.id)}
              disabled={connected || busy || r.cidrCount === 0}
            />
            <span className="region-text">
              <span className="region-name">
                {r.name}
                <span className="muted">
                  {r.cidrCount > 0 ? ` · ${r.cidrCount}` : " · chưa có IP"}
                </span>
              </span>
              {r.note ? <span className="region-note">{r.note}</span> : null}
            </span>
          </label>
        ))}
        {game.customProfile ? (
          <p className="hint">Đang dùng profile tùy chỉnh trong thư mục dữ liệu app.</p>
        ) : null}
      </section>

      <button
        type="button"
        className={`btn primary toggle${connected ? " connected" : ""}`}
        onClick={onToggle}
        disabled={busy || (!connected && routedCount === 0)}
      >
        {busy ? "…" : connected ? "Ngắt kết nối" : "Kết nối"}
      </button>
      {error ? <p className="error">{error}</p> : null}

      {canEditRelay ? (
        <details className="config">
          <summary>
            Relay thủ công (developer)
            <span className="muted"> · đang dùng {RELAY_SOURCE[relay.source]}</span>
          </summary>
          <p className="hint">Để trống để dùng relay do admin cấu hình trên máy chủ.</p>
          <label>
            Endpoint
            <input
              value={relayOverride.endpoint}
              onChange={(e) => onRelayOverrideChange({ ...relayOverride, endpoint: e.target.value })}
              placeholder={relay.endpoint || "203.0.113.10:51820"}
              autoComplete="off"
              disabled={connected || busy}
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
              disabled={connected || busy}
            />
          </label>
        </details>
      ) : null}
    </section>
  );
}
